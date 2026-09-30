import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const config = JSON.parse(fs.readFileSync(path.join(root, 'cloudbaserc.json'), 'utf8'));
const envId = String(config.envId || '').trim();
const region = 'ap-shanghai';
const bin = path.join(root, 'node_modules', '@cloudbase', 'cli', 'bin', 'tcb');
if (!envId) throw new Error('cloudbaserc.json 缺少 envId');

function api(action, body) {
  const args = ['api','tcb',action,'--api-version','2018-06-08','--body',JSON.stringify(body),'--json','-r',region];
  const result = spawnSync(process.execPath, [bin, ...args], { cwd:root, encoding:'utf8', windowsHide:true });
  if (result.status !== 0) throw new Error(`${action} failed: ${(result.stdout || '')}${(result.stderr || '')}`);
  const text = result.stdout || '';
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`${action}: JSON response missing`);
  return JSON.parse(text.slice(start)).data;
}

const list = api('DescribeApiKeyList', { EnvId:envId, PageNumber:1, PageSize:10, KeyType:'publish_key' });
let publish = list?.Data?.[0];
if (!publish?.ApiKey || publish.ApiKey.includes('*')) {
  publish = api('CreateApiKey', { EnvId:envId, KeyType:'publish_key' });
}
if (!publish?.ApiKey) throw new Error('Publishable Key creation failed');

const envText = [
  `CLOUDBASE_ENV_ID=${envId}`,
  `CLOUDBASE_PUBLISH_KEY=${publish.ApiKey}`,
  '',
].join('\n');
fs.writeFileSync(path.join(root,'.env.production.local'), envText, { mode:0o600 });

console.log(JSON.stringify({
  ok:true,
  envId,
  publishKeyId:publish.KeyId || null,
  publishKeyExpireAt:publish.ExpireAt || null,
  envFile:'.env.production.local',
  serverSecretCreated:false,
}, null, 2));
