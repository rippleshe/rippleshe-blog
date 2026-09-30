-- Browser-facing PostgreSQL RPC layer for Rippleshe guestbook.
-- Identity comes only from CloudBase JWT helpers (auth.uid/auth.email).
-- Browser roles never receive direct table access.

create table if not exists public.rippleshe_guest_settings (
  id smallint primary key check (id = 1),
  registration_open boolean not null default false,
  writing_open boolean not null default false,
  registration_until timestamptz,
  writing_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.rippleshe_guest_settings add column if not exists registration_until timestamptz;
alter table public.rippleshe_guest_settings add column if not exists writing_until timestamptz;
insert into public.rippleshe_guest_settings(id, registration_open, writing_open)
values (1, false, false)
on conflict (id) do nothing;

create table if not exists public.rippleshe_guest_owners (
  uid text primary key,
  created_at timestamptz not null default now()
);

alter table public.rippleshe_guest_settings enable row level security;
alter table public.rippleshe_guest_owners enable row level security;
revoke all on table public.rippleshe_guest_settings from public, anon, authenticated;
revoke all on table public.rippleshe_guest_owners from public, anon, authenticated;
grant all on table public.rippleshe_guest_settings to service_role;
grant all on table public.rippleshe_guest_owners to service_role;

create or replace function public.rippleshe_guest_config_web()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object('ok',true,'data',jsonb_build_object(
    'registration_open',coalesce((select registration_open and (registration_until is null or registration_until > now()) from public.rippleshe_guest_settings where id=1),false),
    'writing_open',coalesce((select writing_open and (writing_until is null or writing_until > now()) from public.rippleshe_guest_settings where id=1),false),
    'registration_until',(select registration_until from public.rippleshe_guest_settings where id=1),
    'writing_until',(select writing_until from public.rippleshe_guest_settings where id=1),
    'auth','email-password'
  ));
$$;

create or replace function public.rippleshe_guest_public_state_web(p_limit integer default 80)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select public.rippleshe_guest_public_state(p_limit);
$$;

create or replace function public.rippleshe_guest_me_web()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  u text := auth.uid();
  e text := lower(trim(coalesce(auth.email(),'')));
  result jsonb;
begin
  if coalesce(u,'') = '' then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('user',null));
  end if;
  result := public.rippleshe_guest_me(u);
  if result #>> '{data,needs_profile}' = 'true' then
    result := jsonb_set(result, '{data,email}', to_jsonb(e), true);
  end if;
  return result;
end;
$$;

create or replace function public.rippleshe_guest_save_profile_web(
  p_username text,
  p_nickname text,
  p_greeting text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  u text := auth.uid();
  e text := lower(trim(coalesce(auth.email(),'')));
  username_clean text := normalize(trim(coalesce(p_username,'')), NFKC);
  username_norm text;
  nickname_clean text := regexp_replace(trim(coalesce(p_nickname,'')), '[[:space:]]+', ' ', 'g');
  greeting_clean text := regexp_replace(trim(coalesce(p_greeting,'')), '[[:space:]]+', ' ', 'g');
begin
  if coalesce(u,'') = '' then
    return jsonb_build_object('ok',false,'code','AUTH_REQUIRED','message','邮箱还没有验证完成。');
  end if;
  if e = '' then
    return jsonb_build_object('ok',false,'code','EMAIL_REQUIRED','message','请先用邮箱验证身份，再认来客签。');
  end if;
  if char_length(username_clean) < 2 or char_length(username_clean) > 24
     or username_clean ~ '[[:space:]/\\?#@:]'
     or username_clean ~ '[[:cntrl:]]' then
    return jsonb_build_object('ok',false,'code','BAD_USERNAME','message','用户名用 2–24 个中英文、数字、点、横线或下划线就好。');
  end if;
  if nickname_clean = '' or char_length(nickname_clean) > 30 then
    return jsonb_build_object('ok',false,'code','BAD_NICKNAME','message','昵称留在 1–30 个字以内吧。');
  end if;
  if char_length(greeting_clean) > 80 then
    return jsonb_build_object('ok',false,'code','BAD_GREETING','message','初见一句留在 80 个字以内吧。');
  end if;
  username_norm := lower(username_clean);
  -- The registration gate controls starting a new email-registration flow at EdgeOne.
  -- Once CloudBase has authenticated the email, allow that already-started visitor to
  -- finish the guest profile even if the short registration window closed meanwhile.
  return public.rippleshe_guest_save_profile(
    u,e,username_clean,username_norm,nickname_clean,greeting_clean,true
  );
end;
$$;

create or replace function public.rippleshe_guest_post_message_web(p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  u text := auth.uid();
  body_clean text := trim(coalesce(p_body,''));
  write_open boolean := false;
begin
  if coalesce(u,'') = '' then
    return jsonb_build_object('ok',false,'code','AUTH_REQUIRED','message','先用邮箱认一个名字，再落笔。');
  end if;
  select writing_open and (writing_until is null or writing_until > now())
    into write_open
    from public.rippleshe_guest_settings
    where id=1;
  if not coalesce(write_open,false) then
    return jsonb_build_object('ok',false,'code','WRITING_CLOSED','message','这会儿先只读水边旧字，还没有开放落笔。');
  end if;
  if body_clean = '' then
    return jsonb_build_object('ok',false,'code','EMPTY_MESSAGE','message','这一页还是空的。');
  end if;
  if char_length(body_clean) > 600 then
    return jsonb_build_object('ok',false,'code','MESSAGE_TOO_LONG','message','这一页写得太满了，留在 600 字以内吧。');
  end if;
  return public.rippleshe_guest_post_message(u, body_clean);
end;
$$;

create or replace function public.rippleshe_guest_is_owner()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists(select 1 from public.rippleshe_guest_owners where uid=auth.uid());
$$;

create or replace function public.rippleshe_guest_owner_visitors_web()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.rippleshe_guest_is_owner() then
    return jsonb_build_object('ok',false,'code','FORBIDDEN','message','这页只给主人看。');
  end if;
  return public.rippleshe_guest_owner_visitors();
end;
$$;

create or replace function public.rippleshe_guest_owner_messages_web()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.rippleshe_guest_is_owner() then
    return jsonb_build_object('ok',false,'code','FORBIDDEN','message','这页只给主人看。');
  end if;
  return public.rippleshe_guest_owner_messages();
end;
$$;

create or replace function public.rippleshe_guest_owner_delete_message_web(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.rippleshe_guest_is_owner() then
    return jsonb_build_object('ok',false,'code','FORBIDDEN','message','这页只给主人看。');
  end if;
  return public.rippleshe_guest_owner_delete_message(p_id);
end;
$$;

create or replace function public.rippleshe_guest_owner_delete_user_web(p_uid text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.rippleshe_guest_is_owner() then
    return jsonb_build_object('ok',false,'code','FORBIDDEN','message','这页只给主人看。');
  end if;
  if p_uid = auth.uid() then
    return jsonb_build_object('ok',false,'code','OWNER_SELF_PROTECT','message','主人不能把自己移出来客簿。');
  end if;
  return public.rippleshe_guest_owner_delete_user(p_uid);
end;
$$;

create or replace function public.rippleshe_guest_owner_status_web()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object('ok',true,'data',jsonb_build_object(
    'authenticated',coalesce(auth.uid(),'') <> '',
    'owner',public.rippleshe_guest_is_owner(),
    'uid',coalesce(auth.uid(),''),
    'email',coalesce(auth.email(),'')
  ));
$$;

revoke all on function public.rippleshe_guest_config_web() from public, anon, authenticated;
revoke all on function public.rippleshe_guest_public_state_web(integer) from public, anon, authenticated;
revoke all on function public.rippleshe_guest_me_web() from public, anon, authenticated;
revoke all on function public.rippleshe_guest_save_profile_web(text,text,text) from public, anon, authenticated;
revoke all on function public.rippleshe_guest_post_message_web(text) from public, anon, authenticated;
revoke all on function public.rippleshe_guest_is_owner() from public, anon, authenticated;
revoke all on function public.rippleshe_guest_owner_status_web() from public, anon, authenticated;
revoke all on function public.rippleshe_guest_owner_visitors_web() from public, anon, authenticated;
revoke all on function public.rippleshe_guest_owner_messages_web() from public, anon, authenticated;
revoke all on function public.rippleshe_guest_owner_delete_message_web(bigint) from public, anon, authenticated;
revoke all on function public.rippleshe_guest_owner_delete_user_web(text) from public, anon, authenticated;

grant execute on function public.rippleshe_guest_config_web() to anon, authenticated, service_role;
grant execute on function public.rippleshe_guest_public_state_web(integer) to anon, authenticated, service_role;
grant execute on function public.rippleshe_guest_me_web() to authenticated, service_role;
grant execute on function public.rippleshe_guest_save_profile_web(text,text,text) to authenticated, service_role;
grant execute on function public.rippleshe_guest_post_message_web(text) to authenticated, service_role;
grant execute on function public.rippleshe_guest_owner_status_web() to authenticated, service_role;
grant execute on function public.rippleshe_guest_owner_visitors_web() to authenticated, service_role;
grant execute on function public.rippleshe_guest_owner_messages_web() to authenticated, service_role;
grant execute on function public.rippleshe_guest_owner_delete_message_web(bigint) to authenticated, service_role;
grant execute on function public.rippleshe_guest_owner_delete_user_web(text) to authenticated, service_role;
