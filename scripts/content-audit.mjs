import fs from 'node:fs/promises';
import path from 'node:path';
import { listGardenNotes, readFolios, readLibrary } from './content-core.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const [library, folioData, notes] = await Promise.all([
  readLibrary(),
  readFolios(),
  listGardenNotes(),
]);

const failures = [];
const noteByRef = new Map(notes.map((note) => [String(note.id).replace(/\.md$/i, ''), note]));
const itemById = new Map();
const folioIds = new Set();
const bound = new Map();

function fail(message) { failures.push(message); }
function validDate(value) { return Number.isFinite(new Date(value).valueOf()); }
async function assertPublicFile(url, label) {
  if (!url || !String(url).startsWith('/')) return fail(`${label} 的路径无效：${url || '(empty)'}`);
  try { await fs.access(path.join(PUBLIC, String(url).replace(/^\/+/, ''))); }
  catch { fail(`${label} 指向不存在的文件：${url}`); }
}
for (const item of library.items || []) {
  if (!item.id) { fail('library 中存在没有 id 的素材'); continue; }
  if (itemById.has(item.id)) fail(`library id 重复：${item.id}`);
  itemById.set(item.id, item);
  if (!validDate(item.date)) fail(`素材 ${item.id} 日期无效：${item.date}`);
  await assertPublicFile(item.src, `素材 ${item.id}`);
  if (item.thumb) await assertPublicFile(item.thumb, `素材 ${item.id} 缩略图`);
}

for (const folio of folioData.folios || []) {
  if (!folio.id) { fail('folios 中存在没有 id 的册页'); continue; }
  if (folioIds.has(folio.id)) fail(`册页 id 重复：${folio.id}`);
  folioIds.add(folio.id);
  if (!validDate(folio.date)) fail(`册页 ${folio.id} 日期无效：${folio.date}`);
  if (!Array.isArray(folio.items) || folio.items.length < 2) fail(`册页《${folio.title || folio.id}》少于两项内容`);

  for (const ref of folio.items || []) {
    const cleanRef = String(ref.ref || '').replace(/\.md$/i, '');
    const key = `${ref.source}:${cleanRef}`;
    if (bound.has(key)) fail(`${key} 同时出现在《${bound.get(key)}》与《${folio.title}》`);
    else bound.set(key, folio.title || folio.id);
    if (ref.source === 'garden') {
      const note = noteByRef.get(cleanRef);
      if (!note) fail(`册页《${folio.title}》引用了不存在的文字：${cleanRef}`);
      else if (folio.publish !== false && note.publish === false) fail(`公开册页《${folio.title}》引用了草稿：${cleanRef}`);
    } else if (ref.source === 'library') {
      const item = itemById.get(cleanRef);
      if (!item) fail(`册页《${folio.title}》引用了不存在的素材：${cleanRef}`);
      else if (folio.publish !== false && item.publish === false) fail(`公开册页《${folio.title}》引用了未展示素材：${cleanRef}`);
    } else {
      fail(`册页《${folio.title}》含未知来源：${ref.source}`);
    }
  }
}

const summary = {
  notes: notes.length,
  libraryItems: library.items?.length || 0,
  folios: folioData.folios?.length || 0,
  boundItems: bound.size,
  failures,
  ok: failures.length === 0,
};
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exit(1);
