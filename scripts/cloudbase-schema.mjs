import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const envId = process.env.CLOUDBASE_ENV_ID || 'rippleshe-blog-d0gdjxo8tc4ebc075';
const region = 'ap-shanghai';
const cli = path.join(root, 'node_modules', '@cloudbase', 'cli', 'bin', 'tcb');

const sqlFiles = [
  path.join(root, 'cloudbase', 'schema.sql'),
  path.join(root, 'cloudbase', 'web-rpc.sql'),
];
const sql = sqlFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n\n');

const badDollarLines = sql
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line === 'as $' || line === '$;');
if (badDollarLines.length) {
  throw new Error(`CloudBase SQL contains malformed single-dollar function quotes (${badDollarLines.length})`);
}
if (!sql.includes('rippleshe_guest_config_web') || !sql.includes('rippleshe_guest_owner_status_web')) {
  throw new Error('CloudBase SQL is missing required guestbook RPC definitions');
}

const body = JSON.stringify({ EnvId: envId, Sql: sql });
const result = spawnSync(process.execPath, [
  cli,
  'api', 'tcb', 'ExecutePGSql',
  '--api-version', '2018-06-08',
  '--body', body,
  '--json',
  '-r', region,
], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 20 * 1024 * 1024,
});

if (result.status !== 0) {
  process.stderr.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status || 1);
}
const text = result.stdout || '';
const start = text.indexOf('{');
if (start < 0) throw new Error('ExecutePGSql JSON response missing');
const payload = JSON.parse(text.slice(start));
console.log(JSON.stringify({
  ok: true,
  requestId: payload.data?.RequestId,
  affectedRows: payload.data?.AffectedRows,
  executionTimeMs: payload.data?.ExecutionTimeMs,
}, null, 2));
