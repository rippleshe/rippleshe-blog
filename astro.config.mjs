// @ts-check
import { defineConfig } from 'astro/config';
import ripplesheDevGarden from './dev-toolbar/rippleshe-integration.ts';

export default defineConfig({
  integrations: [ripplesheDevGarden()],
  devToolbar: { enabled: false },
  markdown: {
    shikiConfig: { theme: 'github-light' },
  },
  build: { format: 'directory' },
});
