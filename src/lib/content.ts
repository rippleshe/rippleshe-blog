import type { CollectionEntry } from 'astro:content';

export type GardenEntry = CollectionEntry<'garden'>;

export function titleOf(entry: GardenEntry) {
  if (entry.data.title) return entry.data.title;
  return entry.id.split('/').at(-1)?.replace(/\.mdx?$/, '').replaceAll('-', ' ') ?? entry.id;
}

export function gardenUrl(entry: GardenEntry) {
  return `/garden/${entry.id.replace(/\.mdx?$/, '')}/`;
}

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date).replaceAll('/', '.');
}

export function seasonOf(date: Date) {
  const m = date.getMonth() + 1;
  if (m >= 3 && m <= 5) return '春';
  if (m >= 6 && m <= 8) return '夏';
  if (m >= 9 && m <= 11) return '秋';
  return '冬';
}
