// --- @elurjs/kit/content — public API ---
//
// Content layer for Elur Kit: Markdown collections with typed frontmatter.
//
// Usage:
//   // src/content/config.ts
//   import { defineCollection } from "@elurjs/kit/content";
//   export const collections = {
//     blog: defineCollection({ schema: z.object({ title: z.string() }) }),
//   };
//
//   // src/app/blog/[slug]/page.data.ts
//   import { getEntry } from "@elurjs/kit/content";
//   export const load = async ({ params }) => ({
//     post: await getEntry("blog", params.slug),
//   });

export {
  defineCollection,
  getCollection,
  getEntry,
  getEntries,
  renderEntryHTML,
  setContentRoot,
  withContentRoot,
  clearContentCache,
  type CollectionDefinition,
  type CollectionsConfig,
  type ContentEntry,
} from "./collections.js";

export { parseDocument, parseFrontmatter, splitFrontmatter } from "./frontmatter.js";
export { renderMarkdown } from "./markdown.js";
export { raw } from "./raw.js";
export { createValidator, getZod, type SchemaValidator } from "./schema.js";
