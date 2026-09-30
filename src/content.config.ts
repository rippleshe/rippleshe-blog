import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

const garden = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/garden' }),
  schema: z.object({
    title: z.string().optional(),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    kind: z.enum(['小札', '诗', '词', '短文', '信', '摘记']).default('小札'),
    lang: z.enum(['zh', 'en']).default('zh'),
    publish: z.boolean().default(true),
    featured: z.boolean().default(false),
    description: z.string().optional(),
    kb_id: z.string().optional(),
    source: z.string().optional(),
    source_file: z.string().optional(),
    date_status: z.string().optional(),
  }),
});

export const collections = { garden };


