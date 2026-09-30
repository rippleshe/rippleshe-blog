import folioData from '../data/folios.json';

export type FolioRef = {
  source: 'garden' | 'library';
  ref: string;
};

export type Folio = {
  id: string;
  title: string;
  date: string;
  intro?: string;
  publish?: boolean;
  items: FolioRef[];
};

export const folios = [...(folioData.folios as Folio[])].sort(
  (a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title, 'zh-CN'),
);

export const publicFolios = folios.filter((folio) => folio.publish !== false);

export function folioUrl(folio: Pick<Folio, 'id'>) {
  return `/life/${folio.id}/`;
}

export function folioMemberKey(ref: FolioRef) {
  return `${ref.source}:${ref.ref.replace(/\.md$/i, '')}`;
}
