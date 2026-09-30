import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(process.cwd());
const publish = process.argv.includes('--publish');
const pnpmCli = process.env.npm_execpath || '';

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

async function loadReleaseEnv() {
  const merged = {};
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    try { Object.assign(merged, parseEnv(await fs.readFile(path.join(ROOT, name), 'utf8'))); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return { ...merged, ...process.env };
}

function runNodeCli(cli, args, env, { quiet = false } = {}) {
  if (!cli) throw new Error('当前进程没有 npm_execpath；请通过 pnpm release:check / pnpm release:site 运行发布链。');
  console.log(`\n> pnpm ${args.join(' ')}`);
  const isJsCli = /\.(?:c?js|mjs)$/i.test(cli);
  const command = isJsCli ? process.execPath : cli;
  const commandArgs = isJsCli ? [cli, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd:ROOT,
    env,
    stdio:quiet ? 'ignore' : 'inherit',
    windowsHide:true,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

const env = await loadReleaseEnv();
const envId = String(env.CLOUDBASE_ENV_ID || '').trim();
const publishableKey = String(env.CLOUDBASE_PUBLISH_KEY || '').trim();
const failures = [];
if (!envId) failures.push('缺少 CLOUDBASE_ENV_ID');
if (!publishableKey) failures.push('缺少 CLOUDBASE_PUBLISH_KEY（仅用于 Edge Function 构建）');
if (failures.length) {
  console.error('\nRippleshe 发布配置还没有完整：');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error('\n运行 pnpm cloudbase:keys 生成本地生产配置；.env.production.local 已被 .gitignore 排除。');
  process.exit(1);
}

console.log('\nRippleshe release gate');
console.log(`  backend: CloudBase Auth + PostgreSQL RPC (${envId})`);
console.log('  frontend: EdgeOne Makers direct upload');
console.log('  public URL: https://rippleshe.cyou');
console.log(`  publish: ${publish ? 'YES' : 'NO / check only'}`);

// ponytail: release checks only built artifacts; run backend/dependency audits when those layers actually change.
runNodeCli(pnpmCli, ['build'], env);
runNodeCli(pnpmCli, ['audit:prod'], env);

if (!publish) {
  console.log('\n✓ Release gate passed. Nothing was uploaded.');
  console.log('  Run pnpm release:site to deploy only the audited dist/ to EdgeOne.');
  process.exit(0);
}

let gateState;
try {
  const response = await fetch(`https://rippleshe.cyou/api/guestbook/config?release_gate=${Date.now()}`, {
    headers:{ 'cache-control':'no-cache' },
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`);
  gateState = payload.data || {};
} catch (error) {
  console.error(`\n发布前无法确认公网 Guestbook 开关：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const temporaryGates = [
  gateState.registration_open && gateState.registration_until ? 'registration' : '',
  gateState.writing_open && gateState.writing_until ? 'writing' : '',
].filter(Boolean);
if (temporaryGates.length) {
  console.error(`\n发布被安全闸阻止：${temporaryGates.join(' + ')} 仍处于临时 TTL 测试窗口。`);
  process.exit(1);
}
console.log(`\nGuestbook publish guard: registration=${Boolean(gateState.registration_open)}, writing=${Boolean(gateState.writing_open)}`);

runNodeCli(pnpmCli, ['exec','edgeone','whoami'], env, { quiet:true });
runNodeCli(pnpmCli, [
  'exec','edgeone','makers','deploy','./dist',
  '--name','rippleshe-overseas','--env','production','--area','overseas','--json',
], env);
runNodeCli(pnpmCli, ['audit:edgeone'], env);

console.log('\n✓ Rippleshe 已发布到 https://rippleshe.cyou，并通过真实公网 Chrome 审计。');
console.log('  CloudBase PG schema、注册开关、写字开关与主人白名单均未被静态发布命令修改。');
