import { syncInbox } from './content-core.mjs';

const items = await syncInbox();
if (!items.length) {
  console.log('没有发现新的图片或文档。');
} else {
  console.log(`已收入 ${items.length} 项内容：`);
  for (const item of items) console.log(`  · ${item.type === 'photo' ? '影像' : '文档'}  ${item.title}`);
}
