import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(process.cwd());
const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('用法：pnpm cloudbase:owner <主人邮箱>');
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
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    }
    return out;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

const env = {
  ...parseEnvFile(path.join(ROOT, '.env.production.local')),
  ...process.env,
};
const envId = String(env.CLOUDBASE_ENV_ID || '').trim();
if (!envId) throw new Error('缺少 CloudBase envId。先运行 pnpm cloudbase:keys。');

const cli = path.join(ROOT, 'node_modules', '@cloudbase', 'cli', 'bin', 'tcb');
if (!fs.existsSync(cli)) throw new Error('找不到项目级 CloudBase CLI。先运行 pnpm install。');

function runTcb(args, { json = false } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exit(result.status || 1);
  }
  if (!json) return result.stdout || '';
  const text = result.stdout || '';
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`CloudBase CLI JSON response missing for: tcb ${args.join(' ')}`);
  return JSON.parse(text.slice(start));
}

function uidOf(user) {
  return String(user?.Uid ?? user?.uid ?? user?.user_id ?? user?.userId ?? user?.id ?? user?._id ?? '').trim();
}

function maskedEmail(value) {
  const [local, domain] = value.split('@');
  const head = local.length <= 2 ? `${local[0] || '*'}*` : `${local.slice(0, 2)}***`;
  return `${head}@${domain}`;
}

function findUser() {
  const result = runTcb(['user', 'list', '-e', envId, '--email', email, '--limit', '20', '--json'], { json:true });
  const users = Array.isArray(result?.data) ? result.data : [];
  if (users.length > 1) throw new Error(`同一邮箱返回了 ${users.length} 个 CloudBase 用户，拒绝自动选择。`);
  return users[0] || null;
}

let user = findUser();
let created = false;
if (!user) {
  const name = `rippleshe-owner-${crypto.createHash('sha256').update(email).digest('hex').slice(0, 12)}`;
  runTcb([
    'user', 'create', name,
    '-e', envId,
    '--email', email,
    '--type', 'internalUser',
    '--status', 'ACTIVE',
    '--description', 'Rippleshe owner account · email-code only',
    '--json',
  ]);
  created = true;
  user = findUser();
}

const uid = uidOf(user);
if (!uid) {
  const keys = user && typeof user === 'object' ? Object.keys(user).join(', ') : '(no user object)';
  throw new Error(`CloudBase 用户存在但无法读取 UID。返回字段：${keys}`);
}
if (uid.length > 256) throw new Error('CloudBase UID 长度异常，拒绝写入主人白名单。');

const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sql = `
insert into public.rippleshe_guest_owners(uid)
values (${sqlLiteral(uid)})
on conflict (uid) do nothing;
`;
const apiBody = JSON.stringify({ EnvId:envId, Sql:sql });
runTcb([
  'api', 'tcb', 'ExecutePGSql',
  '--api-version', '2018-06-08',
  '--body', apiBody,
  '--json',
  '-r', 'ap-shanghai',
], { json:true });

console.log(JSON.stringify({
  ok:true,
  ownerEmail:maskedEmail(email),
  userCreated:created,
  ownerWhitelist:'ready',
  registrationOpen:false,
  writingOpen:false,
  next:'Open https://rippleshe.cyou/visitors/ and request the 6-digit email code.',
}, null, 2));
