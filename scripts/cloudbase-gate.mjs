import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(process.cwd());
const mode = String(process.argv[2] || '').trim();
const value = String(process.argv[3] || '').trim().toLowerCase();
const ttlArg = String(process.argv[4] || '').trim().toLowerCase();
if (!['registration','writing'].includes(mode) || !['on','off','status'].includes(value)) {
  console.error('用法：pnpm cloudbase:gate <registration|writing> <on|off|status> [10m|1h|permanent]');
  process.exit(2);
}

function parseEnvFile(file) {
  try {
    const out = {};
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 1) continue;
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
    return out;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

function ttlSql() {
  if (value !== 'on') return null;
  const token = ttlArg || (mode === 'registration' ? '30m' : '5m');
  if (token === 'permanent') return { token, sql:'null' };
  const match = /^(\d+)(m|h)$/.exec(token);
  if (!match) {
    console.error('TTL 只接受例如 10m、1h，或显式 permanent。');
    process.exit(2);
  }
  const amount = Number(match[1]);
  const minutes = match[2] === 'h' ? amount * 60 : amount;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    console.error('临时开门时间必须在 1 分钟到 24 小时之间。');
    process.exit(2);
  }
  return { token, sql:`now() + interval '${minutes} minutes'` };
}

const env = { ...parseEnvFile(path.join(ROOT, '.env.production.local')), ...process.env };
const envId = String(env.CLOUDBASE_ENV_ID || '').trim();
if (!envId) throw new Error('缺少 CloudBase envId。');
const cli = path.join(ROOT, 'node_modules', '@cloudbase', 'cli', 'bin', 'tcb');
if (!fs.existsSync(cli)) throw new Error('找不到项目级 CloudBase CLI。');

const column = mode === 'registration' ? 'registration_open' : 'writing_open';
const untilColumn = mode === 'registration' ? 'registration_until' : 'writing_until';
const ttl = ttlSql();
let update = '';
if (value === 'off') {
  update = `update public.rippleshe_guest_settings set ${column}=false, ${untilColumn}=null, updated_at=now() where id=1;`;
} else if (value === 'on') {
  update = `update public.rippleshe_guest_settings set ${column}=true, ${untilColumn}=${ttl.sql}, updated_at=now() where id=1;`;
}
const sql = `${update}\nselect registration_open, writing_open, registration_until, writing_until from public.rippleshe_guest_settings where id=1;`;
const body = JSON.stringify({ EnvId:envId, Sql:sql });
const result = spawnSync(process.execPath, [
  cli, 'api','tcb','ExecutePGSql', '--api-version','2018-06-08', '--body',body, '--json', '-r','ap-shanghai'
], { cwd:ROOT, env, encoding:'utf8', windowsHide:true, maxBuffer:20*1024*1024 });
if (result.status !== 0) {
  process.stderr.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status || 1);
}
const text = result.stdout || '';
const start = text.indexOf('{');
if (start < 0) throw new Error('CloudBase JSON response missing');
const payload = JSON.parse(text.slice(start));
const data = payload?.data || {};
let publicState = null;
try {
  const response = await fetch(`https://rippleshe.cyou/api/guestbook/config?gate_check=${Date.now()}`, {
    headers:{ 'cache-control':'no-cache' },
  });
  const responseBody = await response.json();
  if (response.ok && responseBody?.ok === true) publicState = responseBody.data || null;
} catch {}
console.log(JSON.stringify({
  ok:true,
  changed:value !== 'status',
  gate:mode,
  requested:value,
  ttl:value === 'on' ? ttl.token : null,
  registrationOpen:publicState?.registration_open,
  writingOpen:publicState?.writing_open,
  registrationUntil:publicState?.registration_until ?? null,
  writingUntil:publicState?.writing_until ?? null,
  requestId:data?.RequestId,
}, null, 2));
