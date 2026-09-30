import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const input = path.resolve('figures');
const output = path.resolve('public/media/life');
await fs.mkdir(output, { recursive: true });
const files = (await fs.readdir(input)).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).sort();

for (const [index, name] of files.entries()) {
  const source = path.join(input, name);
  const id = String(index + 1).padStart(2, '0');
  await sharp(source).rotate().resize({ width: 1800, withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(output, `life-${id}.webp`));
  await sharp(source).rotate().resize({ width: 720, withoutEnlargement: true }).webp({ quality: 76 }).toFile(path.join(output, `life-${id}-thumb.webp`));
}
console.log(`processed ${files.length} images without carrying EXIF metadata`);
