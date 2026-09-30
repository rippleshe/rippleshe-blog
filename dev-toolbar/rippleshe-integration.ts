import type { AstroIntegration } from 'astro';
import { readFile } from 'node:fs/promises';

const clientScript = new URL('../src/scripts/dev-garden.ts', import.meta.url);

export default function ripplesheDevGarden(): AstroIntegration {
  return {
    name: 'rippleshe-dev-garden',
    hooks: {
      'astro:config:setup': async ({ command, injectScript }) => {
        if (command !== 'dev') return;
        injectScript('page', await readFile(clientScript, 'utf8'));
      },
    },
  };
}
