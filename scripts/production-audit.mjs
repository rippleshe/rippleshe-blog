import fs from 'node:fs/promises';
import path from 'node:path';

const DIST = path.resolve('dist');
const failures = [];

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes:true })) {
    const full = path.join(dir, entry.name);
    out.push(...(entry.isDirectory() ? await walk(full) : [full]));
  }
  return out;
}

const files = await walk(DIST);
const htmlFiles = files.filter((file) => file.endsWith('.html'));
const relFiles = new Set(files.map((file) => `/${path.relative(DIST, file).replaceAll('\\', '/')}`));

function targetExists(href) {
  const clean = href.split(/[?#]/)[0];
  if (!clean.startsWith('/')) return true;
  if (clean === '/') return relFiles.has('/index.html');
  if (path.posix.extname(clean)) return relFiles.has(clean);
  return relFiles.has(`${clean.replace(/\/$/, '')}/index.html`) || relFiles.has(`${clean}.html`);
}

for (const file of htmlFiles) {
  const rel = `/${path.relative(DIST, file).replaceAll('\\', '/')}`;
  const html = await fs.readFile(file, 'utf8');
  if (/(?:127\.0\.0\.1|localhost|:4175|:4185)/i.test(html)) failures.push(`${rel}: localhost leaked`);
  if (/主人钥匙|x-rippleshe-owner/i.test(html)) failures.push(`${rel}: owner secret UI leaked`);
  if (/rippleshe\.example/i.test(html)) failures.push(`${rel}: placeholder domain leaked`);
  for (const [, ref] of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
    if (!/^(?:https?:|mailto:|tel:|data:|javascript:|#)/i.test(ref) && !targetExists(ref)) failures.push(`${rel}: dead internal reference ${ref}`);
  }
}

const browserFiles = files.filter((file) => /\.(?:html|js)$/i.test(file) && !file.includes(`${path.sep}edge-functions${path.sep}`));
for (const file of browserFiles) {
  const source = await fs.readFile(file, 'utf8');
  if (/api\.tcloudbasegateway\.com|@cloudbase\/js-sdk|PUBLIC_CLOUDBASE_ACCESS_KEY|CLOUDBASE_PUBLISH_KEY/i.test(source)) {
    failures.push(`browser artifact exposes CloudBase transport: /${path.relative(DIST, file).replaceAll('\\', '/')}`);
  }
}

const edgeFile = path.join(DIST, 'edge-functions', 'api', 'guestbook', '[[path]].js');
try {
  const edge = await fs.readFile(edgeFile, 'utf8');
  if (edge.includes('__CLOUDBASE_')) failures.push('Edge Function contains unreplaced CloudBase placeholders');
  if (!edge.includes("auth: 'email-password'") || !edge.includes("route === 'auth/password'")) failures.push('Edge Function auth routes are incomplete');
} catch {
  failures.push('Edge Function is missing from dist/');
}

try {
  const owner = await fs.readFile(path.join(DIST, 'visitors', 'index.html'), 'utf8');
  if (/visitors-owner-key|主人钥匙/i.test(owner)) failures.push('/visitors/ contains local owner-key UI');
  if (!/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(owner)) failures.push('/visitors/ is missing noindex');
} catch {}

for (const fragment of ['组织关系', '党组织', '家庭称谓']) {
  if (htmlFiles.some((file) => decodeURIComponent(path.relative(DIST, file)).includes(fragment))) failures.push(`private route leaked: ${fragment}`);
}

console.log(JSON.stringify({ htmlPages:htmlFiles.length, files:files.length, failures, ok:failures.length === 0 }, null, 2));
if (failures.length) process.exit(1);
