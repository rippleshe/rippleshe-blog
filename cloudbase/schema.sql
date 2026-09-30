-- Rippleshe public guestbook — CloudBase PostgreSQL internal schema
-- Browser roles never access these tables directly. web-rpc.sql exposes the only browser-facing RPC surface.
-- Internal functions below are transaction primitives used by the web-safe wrappers.

create table if not exists public.rippleshe_guest_profiles (
  uid text primary key,
  email text not null,
  username text not null,
  username_norm text not null,
  nickname text not null,
  greeting text not null default '',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active','deleted')),
  message_window_started_at timestamptz,
  message_window_count integer not null default 0 check (message_window_count >= 0),
  message_count integer not null default 0 check (message_count >= 0)
);

create table if not exists public.rippleshe_guest_usernames (
  username_norm text primary key,
  uid text not null unique references public.rippleshe_guest_profiles(uid) on delete cascade,
  username text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.rippleshe_guest_messages (
  id bigserial primary key,
  uid text not null references public.rippleshe_guest_profiles(uid),
  body text not null check (char_length(body) between 1 and 600),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  username text not null,
  nickname text not null,
  greeting text not null default ''
);

create index if not exists rippleshe_guest_profiles_status_created_idx
  on public.rippleshe_guest_profiles(status, created_at desc);
create index if not exists rippleshe_guest_messages_created_idx
  on public.rippleshe_guest_messages(created_at desc);
create index if not exists rippleshe_guest_messages_uid_deleted_idx
  on public.rippleshe_guest_messages(uid, deleted_at);

alter table public.rippleshe_guest_profiles enable row level security;
alter table public.rippleshe_guest_usernames enable row level security;
alter table public.rippleshe_guest_messages enable row level security;

revoke all on table public.rippleshe_guest_profiles from public, anon, authenticated;
revoke all on table public.rippleshe_guest_usernames from public, anon, authenticated;
revoke all on table public.rippleshe_guest_messages from public, anon, authenticated;
revoke all on sequence public.rippleshe_guest_messages_id_seq from public, anon, authenticated;

grant all on table public.rippleshe_guest_profiles to service_role;
grant all on table public.rippleshe_guest_usernames to service_role;
grant all on table public.rippleshe_guest_messages to service_role;
grant usage, select on sequence public.rippleshe_guest_messages_id_seq to service_role;

create or replace function public.rippleshe_guest_me(p_uid text)
returns jsonb
language plpgsql
as $$
declare
  p public.rippleshe_guest_profiles%rowtype;
begin
  if coalesce(p_uid,'') = '' then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('user',null));
  end if;
  select * into p from public.rippleshe_guest_profiles where uid=p_uid;
  if not found or p.status <> 'active' then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('user',null,'needs_profile',true));
  end if;
  update public.rippleshe_guest_profiles set last_seen_at=now() where uid=p_uid;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'user',jsonb_build_object('id',p.uid,'username',p.username,'nickname',p.nickname,'greeting',p.greeting)
  ));
end;
$$;

create or replace function public.rippleshe_guest_save_profile(
  p_uid text, p_email text, p_username text, p_username_norm text, p_nickname text, p_greeting text, p_registration_open boolean
)
returns jsonb
language plpgsql
as $$
declare
  existing public.rippleshe_guest_profiles%rowtype;
  reserved_uid text;
  created_ts timestamptz := now();
begin
  select * into existing from public.rippleshe_guest_profiles where uid=p_uid for update;
  if not found and not coalesce(p_registration_open,false) then
    return jsonb_build_object('ok',false,'code','REGISTRATION_CLOSED','message','来客登记还没有正式开放。');
  end if;
  if found then
    if existing.status <> 'active' then
      return jsonb_build_object('ok',false,'code','ACCOUNT_DISABLED','message','这张来客签暂时没有开放。');
    end if;
    if existing.username_norm <> p_username_norm then
      return jsonb_build_object('ok',false,'code','USERNAME_LOCKED','message','来客门牌暂时不支持改名。');
    end if;
    created_ts := existing.created_at;
  end if;

  select uid into reserved_uid from public.rippleshe_guest_usernames where username_norm=p_username_norm for update;
  if reserved_uid is not null and reserved_uid <> p_uid then
    return jsonb_build_object('ok',false,'code','USERNAME_TAKEN','message','这个用户名已经有人拾走了，换一个吧。');
  end if;

  insert into public.rippleshe_guest_profiles(
    uid,email,username,username_norm,nickname,greeting,created_at,last_seen_at,status,
    message_window_started_at,message_window_count,message_count
  ) values (
    p_uid,p_email,p_username,p_username_norm,p_nickname,coalesce(p_greeting,''),created_ts,now(),'active',
    existing.message_window_started_at,coalesce(existing.message_window_count,0),coalesce(existing.message_count,0)
  )
  on conflict(uid) do update set
    email=excluded.email,
    username=excluded.username,
    username_norm=excluded.username_norm,
    nickname=excluded.nickname,
    greeting=excluded.greeting,
    last_seen_at=now(),
    status='active';

  insert into public.rippleshe_guest_usernames(username_norm,uid,username,updated_at)
  values(p_username_norm,p_uid,p_username,now())
  on conflict(username_norm) do update set username=excluded.username, updated_at=now();

  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'user',jsonb_build_object('id',p_uid,'username',p_username,'nickname',p_nickname,'greeting',coalesce(p_greeting,''))
  ));
exception when unique_violation then
  return jsonb_build_object('ok',false,'code','USERNAME_TAKEN','message','这个用户名已经有人拾走了，换一个吧。');
end;
$$;

create or replace function public.rippleshe_guest_post_message(p_uid text, p_body text)
returns jsonb
language plpgsql
as $$
declare
  p public.rippleshe_guest_profiles%rowtype;
  same_window boolean;
  c integer;
  new_id bigint;
  created_ts timestamptz := now();
begin
  select * into p from public.rippleshe_guest_profiles where uid=p_uid for update;
  if not found or p.status <> 'active' then
    return jsonb_build_object('ok',false,'code','PROFILE_REQUIRED','message','先把来客签认完整，再落笔。');
  end if;
  same_window := p.message_window_started_at is not null and now() - p.message_window_started_at < interval '10 minutes';
  c := case when same_window then p.message_window_count else 0 end;
  if c >= 6 then
    return jsonb_build_object('ok',false,'code','RATE_LIMIT','message','墨迹还没干，过一会儿再写下一张。');
  end if;

  update public.rippleshe_guest_profiles set
    message_window_started_at=case when same_window then p.message_window_started_at else created_ts end,
    message_window_count=c+1,
    message_count=p.message_count+1,
    last_seen_at=created_ts
  where uid=p_uid;

  insert into public.rippleshe_guest_messages(uid,body,created_at,username,nickname,greeting)
  values(p_uid,p_body,created_ts,p.username,p.nickname,p.greeting)
  returning id into new_id;

  return jsonb_build_object('ok',true,'data',jsonb_build_object('message',jsonb_build_object(
    'id',new_id,'body',p_body,'created_at',created_ts,'username',p.username,'nickname',p.nickname,'greeting',p.greeting
  )));
end;
$$;

create or replace function public.rippleshe_guest_public_state(p_limit integer default 80)
returns jsonb
language sql
as $$
with lim as (select greatest(1,least(coalesce(p_limit,80),120))::int as n),
msg as (
  select m.id,m.body,m.created_at,m.username,m.nickname,m.greeting
  from public.rippleshe_guest_messages m
  join public.rippleshe_guest_profiles p on p.uid=m.uid and p.status='active'
  where m.deleted_at is null
  order by m.created_at desc
  limit (select n from lim)
),
stats as (
  select
    (select count(*) from public.rippleshe_guest_profiles where status='active') as visitors,
    (select count(*) from public.rippleshe_guest_messages m join public.rippleshe_guest_profiles p on p.uid=m.uid and p.status='active' where m.deleted_at is null) as messages
)
select jsonb_build_object('ok',true,'data',jsonb_build_object(
  'messages',coalesce((select jsonb_agg(to_jsonb(msg) order by created_at desc) from msg),'[]'::jsonb),
  'stats',jsonb_build_object('visitors',(select visitors from stats),'messages',(select messages from stats))
));
$$;

create or replace function public.rippleshe_guest_owner_visitors()
returns jsonb
language sql
as $$
with users as (
  select uid as id,email,username,nickname,greeting,created_at,last_seen_at,status,message_count
  from public.rippleshe_guest_profiles where status='active' order by created_at desc limit 300
), stats as (
  select
    (select count(*) from public.rippleshe_guest_profiles where status='active') as visitors,
    (select count(*) from public.rippleshe_guest_messages m join public.rippleshe_guest_profiles p on p.uid=m.uid and p.status='active' where m.deleted_at is null) as messages
)
select jsonb_build_object('ok',true,'data',jsonb_build_object(
  'users',coalesce((select jsonb_agg(to_jsonb(users) order by created_at desc) from users),'[]'::jsonb),
  'stats',jsonb_build_object('visitors',(select visitors from stats),'messages',(select messages from stats))
));
$$;

create or replace function public.rippleshe_guest_owner_messages()
returns jsonb
language sql
as $$
select jsonb_build_object('ok',true,'data',jsonb_build_object(
  'messages',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',m.id,'body',m.body,'created_at',m.created_at,'deleted_at',m.deleted_at,
      'email',coalesce(p.email,''),'username',coalesce(m.username,p.username,''),'nickname',coalesce(m.nickname,p.nickname,'')
    ) order by m.created_at desc)
    from (select * from public.rippleshe_guest_messages order by created_at desc limit 300) m
    left join public.rippleshe_guest_profiles p on p.uid=m.uid
  ),'[]'::jsonb)
));
$$;

create or replace function public.rippleshe_guest_owner_delete_message(p_id bigint)
returns jsonb
language plpgsql
as $$
declare
  m public.rippleshe_guest_messages%rowtype;
begin
  select * into m from public.rippleshe_guest_messages where id=p_id for update;
  if not found then
    return jsonb_build_object('ok',false,'code','NOT_FOUND','message','没有找到这一张。');
  end if;
  if m.deleted_at is not null then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('removed',true));
  end if;
  update public.rippleshe_guest_messages set deleted_at=now() where id=p_id;
  update public.rippleshe_guest_profiles set message_count=greatest(message_count-1,0) where uid=m.uid;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('removed',true));
end;
$$;

create or replace function public.rippleshe_guest_owner_delete_user(p_uid text)
returns jsonb
language plpgsql
as $$
begin
  if not exists(select 1 from public.rippleshe_guest_profiles where uid=p_uid) then
    return jsonb_build_object('ok',false,'code','NOT_FOUND','message','没有找到这位来客。');
  end if;
  update public.rippleshe_guest_profiles set status='deleted',last_seen_at=now(),message_count=0 where uid=p_uid;
  delete from public.rippleshe_guest_usernames where uid=p_uid;
  update public.rippleshe_guest_messages set deleted_at=coalesce(deleted_at,now()) where uid=p_uid and deleted_at is null;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('removed',true));
end;
$$;

revoke all on function public.rippleshe_guest_me(text) from public, anon, authenticated;
drop function if exists public.rippleshe_guest_save_profile(text,text,text,text,text,text);
revoke all on function public.rippleshe_guest_save_profile(text,text,text,text,text,text,boolean) from public, anon, authenticated;
revoke all on function public.rippleshe_guest_post_message(text,text) from public, anon, authenticated;
revoke all on function public.rippleshe_guest_public_state(integer) from public, anon, authenticated;
revoke all on function public.rippleshe_guest_owner_visitors() from public, anon, authenticated;
revoke all on function public.rippleshe_guest_owner_messages() from public, anon, authenticated;
revoke all on function public.rippleshe_guest_owner_delete_message(bigint) from public, anon, authenticated;
revoke all on function public.rippleshe_guest_owner_delete_user(text) from public, anon, authenticated;

grant execute on function public.rippleshe_guest_me(text) to service_role;
grant execute on function public.rippleshe_guest_save_profile(text,text,text,text,text,text,boolean) to service_role;
grant execute on function public.rippleshe_guest_post_message(text,text) to service_role;
grant execute on function public.rippleshe_guest_public_state(integer) to service_role;
grant execute on function public.rippleshe_guest_owner_visitors() to service_role;
grant execute on function public.rippleshe_guest_owner_messages() to service_role;
grant execute on function public.rippleshe_guest_owner_delete_message(bigint) to service_role;
grant execute on function public.rippleshe_guest_owner_delete_user(text) to service_role;



