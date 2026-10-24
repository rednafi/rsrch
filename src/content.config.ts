import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// One Markdown file per doc. Assets sit next to it. The `slug` field becomes the URL.
// retainBody: false keeps only the rendered HTML in the store, not the Markdown too.
const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: process.env.DOCS_DIR ?? "./src/content/docs", retainBody: false }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
  }),
});

export const collections = { docs };
