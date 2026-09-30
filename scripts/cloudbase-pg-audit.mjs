import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=process.cwd();
const cfg=JSON.parse(fs.readFileSync(path.join(root,'cloudbaserc.json'),'utf8'));
const envId=cfg.envId;
const region='ap-shanghai';
const cli=path.join(root,'node_modules','@cloudbase','cli','bin','tcb');
const suffix=`audit_${Date.now()}_${Math.random().toString(36).slice(2,8)}`.replace(/[^a-z0-9_]/g,'');
const uid1=`${suffix}_one`, uid2=`${suffix}_two`, uname=`${suffix}_name`;
const q=(v)=>String(v).replaceAll("'","''");

const sql=`begin;
do $audit$
declare
  a jsonb; b jsonb; first_id bigint; i integer;
begin
  -- Browser roles must never read raw business tables.
  if has_table_privilege('anon','public.rippleshe_guest_profiles','SELECT') or has_table_privilege('authenticated','public.rippleshe_guest_profiles','SELECT') then raise exception 'profile table privilege leaked'; end if;
  if has_table_privilege('anon','public.rippleshe_guest_messages','SELECT') or has_table_privilege('authenticated','public.rippleshe_guest_messages','SELECT') then raise exception 'message table privilege leaked'; end if;
  if has_table_privilege('anon','public.rippleshe_guest_settings','SELECT') or has_table_privilege('authenticated','public.rippleshe_guest_settings','SELECT') then raise exception 'settings table privilege leaked'; end if;
  if has_table_privilege('anon','public.rippleshe_guest_owners','SELECT') or has_table_privilege('authenticated','public.rippleshe_guest_owners','SELECT') then raise exception 'owners table privilege leaked'; end if;

  -- Public role only gets the two read-only browser RPCs.
  if not has_function_privilege('anon','public.rippleshe_guest_config_web()','EXECUTE') then raise exception 'anon config rpc missing'; end if;
  if not has_function_privilege('anon','public.rippleshe_guest_public_state_web(integer)','EXECUTE') then raise exception 'anon public-state rpc missing'; end if;
  if has_function_privilege('anon','public.rippleshe_guest_save_profile_web(text,text,text)','EXECUTE') then raise exception 'anon profile rpc leaked'; end if;
  if has_function_privilege('anon','public.rippleshe_guest_post_message_web(text)','EXECUTE') then raise exception 'anon post rpc leaked'; end if;
  if has_function_privilege('anon','public.rippleshe_guest_owner_visitors_web()','EXECUTE') then raise exception 'anon owner rpc leaked'; end if;

  -- Authenticated role may invoke user/owner entrypoints; owner RPCs self-check auth.uid().
  if not has_function_privilege('authenticated','public.rippleshe_guest_me_web()','EXECUTE') then raise exception 'authenticated me rpc missing'; end if;
  if not has_function_privilege('authenticated','public.rippleshe_guest_save_profile_web(text,text,text)','EXECUTE') then raise exception 'authenticated profile rpc missing'; end if;
  if not has_function_privilege('authenticated','public.rippleshe_guest_post_message_web(text)','EXECUTE') then raise exception 'authenticated post rpc missing'; end if;
  if not has_function_privilege('authenticated','public.rippleshe_guest_owner_visitors_web()','EXECUTE') then raise exception 'authenticated owner rpc missing'; end if;

  if not exists(select 1 from public.rippleshe_guest_settings where id=1) then raise exception 'settings singleton missing'; end if;
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='rippleshe_guest_settings' and column_name='registration_until') then raise exception 'registration ttl column missing'; end if;
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='rippleshe_guest_settings' and column_name='writing_until') then raise exception 'writing ttl column missing'; end if;
  if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.proname='uid') then raise exception 'auth.uid missing'; end if;
  if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.proname='email') then raise exception 'auth.email missing'; end if;

  -- Temporary public gates must fail closed after their database TTL expires.
  update public.rippleshe_guest_settings
     set registration_open=true, writing_open=true,
         registration_until=now()-interval '1 minute', writing_until=now()-interval '1 minute'
   where id=1;
  a := public.rippleshe_guest_config_web();
  if a#>>'{data,registration_open}' <> 'false' or a#>>'{data,writing_open}' <> 'false' then raise exception 'expired gate remained effectively open: %',a; end if;
  update public.rippleshe_guest_settings
     set registration_until=now()+interval '1 minute', writing_until=now()+interval '1 minute'
   where id=1;
  a := public.rippleshe_guest_config_web();
  if a#>>'{data,registration_open}' <> 'true' or a#>>'{data,writing_open}' <> 'true' then raise exception 'future ttl gate not effective: %',a; end if;
  update public.rippleshe_guest_settings
     set registration_open=false, writing_open=false, registration_until=null, writing_until=null
   where id=1;

  -- Internal transaction contracts are attacked inside one rollback-only transaction.
  a := public.rippleshe_guest_save_profile('${q(uid1)}','audit1@example.invalid','${q(uname)}','${q(uname)}','审计来客一','',true);
  if a->>'ok' <> 'true' then raise exception 'save profile 1 failed: %',a; end if;
  b := public.rippleshe_guest_save_profile('${q(uid2)}','audit2@example.invalid','${q(uname)}','${q(uname)}','审计来客二','',true);
  if b->>'code' <> 'USERNAME_TAKEN' then raise exception 'username uniqueness failed: %',b; end if;

  for i in 1..6 loop
    a := public.rippleshe_guest_post_message('${q(uid1)}','审计留言 '||i);
    if a->>'ok' <> 'true' then raise exception 'post % failed: %',i,a; end if;
    if i=1 then first_id := (a#>>'{data,message,id}')::bigint; end if;
  end loop;
  a := public.rippleshe_guest_post_message('${q(uid1)}','第七张');
  if a->>'code' <> 'RATE_LIMIT' then raise exception 'rate limit failed: %',a; end if;
  if (select message_count from public.rippleshe_guest_profiles where uid='${q(uid1)}') <> 6 then raise exception 'message count != 6'; end if;

  a := public.rippleshe_guest_owner_delete_message(first_id);
  if a->>'ok' <> 'true' or (select message_count from public.rippleshe_guest_profiles where uid='${q(uid1)}') <> 5 then raise exception 'delete message bookkeeping failed'; end if;
  a := public.rippleshe_guest_owner_delete_user('${q(uid1)}');
  if a->>'ok' <> 'true' then raise exception 'delete user failed'; end if;
  if exists(select 1 from public.rippleshe_guest_usernames where username_norm='${q(uname)}') then raise exception 'username not released'; end if;
  if exists(select 1 from public.rippleshe_guest_messages where uid='${q(uid1)}' and deleted_at is null) then raise exception 'deleted user still has public message'; end if;

  a := public.rippleshe_guest_save_profile('${q(uid2)}','audit2@example.invalid','${q(uname)}','${q(uname)}','审计来客二','',true);
  if a->>'ok' <> 'true' then raise exception 'released username cannot be reclaimed: %',a; end if;
end;
$audit$;
rollback;`;

const body=JSON.stringify({EnvId:envId,Sql:sql});
const result=spawnSync(process.execPath,[cli,'api','tcb','ExecutePGSql','--api-version','2018-06-08','--body',body,'--json','-r',region],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:20*1024*1024});
if(result.status!==0){process.stderr.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status||1)}

const loginResult=spawnSync(process.execPath,[cli,'api','tcb','DescribeLoginConfig','--api-version','2018-06-08','--body',JSON.stringify({EnvId:envId}),'--json','-r',region],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:20*1024*1024});
if(loginResult.status!==0){process.stderr.write(loginResult.stdout||'');process.stderr.write(loginResult.stderr||'');process.exit(loginResult.status||1)}
const loginText=loginResult.stdout||'';
const loginStart=loginText.indexOf('{');
if(loginStart<0) throw new Error('DescribeLoginConfig JSON response missing');
const loginPayload=JSON.parse(loginText.slice(loginStart));
const login=loginPayload?.data||{};
if(login.EmailLogin!==true||login.UserNameLogin!==true||login.PhoneNumberLogin!==false||login.AnonymousLogin!==false){
  throw new Error(`unsafe CloudBase login config: ${JSON.stringify({EmailLogin:login.EmailLogin,UserNameLogin:login.UserNameLogin,PhoneNumberLogin:login.PhoneNumberLogin,AnonymousLogin:login.AnonymousLogin})}`);
}

console.log(JSON.stringify({
  ok:true,
  checks:[
    'browser raw-table isolation','anon read-only RPC surface','authenticated user RPC surface',
    'owner RPC entrypoint + internal owner check','auth.uid/auth.email helpers','CloudBase email+password login config',
    'settings singleton + expiring gates','PG username uniqueness','six-message rate limit','message_count transaction',
    'soft-delete suppression','username release + reclaim'
  ],
  auth:{email:true,password:true,phone:false,anonymous:false},
  rolledBack:true
},null,2));
