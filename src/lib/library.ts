import libraryData from '../data/library.json';

export type LibraryItem = {
  id: string;
  type: 'photo' | 'document';
  title: string;
  date: string;
  tags: string[];
  src: string;
  thumb?: string;
  featured?: boolean;
  publish?: boolean;
  legacy?: boolean;
  ext?: string;
  size?: number;
  sourceHash?: string;
  sourceFile?: string;
  width?: number;
  height?: number;
  display?: 'cover' | 'contain';
  galleryOrder?: number;
  gallerySize?: 'narrow' | 'standard' | 'wide' | 'hero';
  galleryRatio?: 'portrait' | 'square' | 'landscape' | 'cinematic';
};

export const allLibraryItems = [...(libraryData.items as LibraryItem[])].sort(
  (a, b) => new Date(b.date).valueOf() - new Date(a.date).valueOf(),
);
export const libraryItems = allLibraryItems.filter((item) => item.publish !== false);

export const photos = libraryItems.filter((item) => item.type === 'photo');
export const galleryPhotos = [...photos].sort(
  (a, b) => (a.galleryOrder ?? Number.MAX_SAFE_INTEGER) - (b.galleryOrder ?? Number.MAX_SAFE_INTEGER) || new Date(b.date).valueOf() - new Date(a.date).valueOf(),
);
export const documents = libraryItems.filter((item) => item.type === 'document');

export function formatLibraryDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}

export function monthKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
