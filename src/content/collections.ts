// --- Content collections ---
//
// A collection is a directory under `src/content/<name>/` containing `.md`
// files. Each file has YAML frontmatter (parsed by our own parser) and a
// Markdown body (rendered via `marked` when requested).
//
// Collections are defined in `src/content/config.ts`:
//
//   import { defineCollection } from "@deijose/nix-js-kit/content";
//   export const collections = {
//     blog: defineCollection({ schema: z.object({ title: z.string() }) }),
//   };
//
// At runtime, `getCollection("blog")` scans the directory, parses frontmatter,
// validates against the schema (if zod is installed), and returns typed
// entries. `getEntry("blog", "hello")` returns a single entry by slug.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDocument } from "./frontmatter.js";
import { renderMarkdown } from "./markdown.js";
import { createValidator, type SchemaValidator } from "./schema.js";
import { AsyncLocalStorage } from "node:async_hooks";

export interface CollectionDefinition {
  /** Schema for frontmatter validation (zod schema or plain function). */
  schema?: unknown;
}

export interface ContentEntry<TData = Record<string, unknown>> {
  /** Collection name, e.g. "blog". */
  collection: string;
  /** Entry slug (filename without `.md`), e.g. "hello-world". */
  slug: string;
  /** Parsed and validated frontmatter. */
  data: TData;
  /** Raw Markdown body (not yet rendered to HTML). */
  body: string;
  /** Rendered HTML body (lazily computed via `renderHTML()`). */
  html?: string;
  /** Absolute path to the source `.md` file. */
  filePath: string;
}

/**
 * Defines a collection with an optional schema. Used in `src/content/config.ts`.
 */
export function defineCollection(def: CollectionDefinition): CollectionDefinition {
  return def;
}

/** Type for the `collections` export from `src/content/config.ts`. */
export type CollectionsConfig = Record<string, CollectionDefinition>;

// --- Internal cache ---

interface CachedCollection {
  entries: ContentEntry[];
  loadedAt: number;
}

const collectionCache = new Map<string, CachedCollection>();
const configCache = new Map<string, CollectionsConfig | null>();

const CACHE_TTL_MS = 5000; // 5 seconds in dev; invalidated on HMR

// Per-request content root via AsyncLocalStorage (plan §11.4).
// Falls back to the global contentRoot set by setContentRoot().
const contentRootALS = new AsyncLocalStorage<string>();

// Global fallback (set by CLI/Vite plugin on startup).
let globalContentRoot: string | null = null;

/**
 * Sets the root directory for content. Called by the Vite plugin / CLI on
 * startup so `getCollection` knows where to find `src/content/`.
 */
export function setContentRoot(root: string): void {
  globalContentRoot = root;
  collectionCache.clear();
  configCache.clear();
}

/**
 * Runs a function with a per-request content root (plan §11.4).
 * This prevents global state leakage between concurrent requests.
 */
export function withContentRoot<T>(root: string, fn: () => T): T {
  return contentRootALS.run(root, fn);
}

function resolveContentRoot(): string {
  // Prefer per-request context.
  const alsRoot = contentRootALS.getStore();
  if (alsRoot) return alsRoot;
  // Fall back to global.
  if (globalContentRoot) return globalContentRoot;
  // Final fallback: assume CWD/src/content.
  return join(process.cwd(), "src", "content");
}

/**
 * Loads the user's `src/content/config.ts` (if it exists) and returns the
 * collections config.
 */
async function loadCollectionsConfig(root: string): Promise<CollectionsConfig | null> {
  const cacheKey = root;
  if (configCache.has(cacheKey)) return configCache.get(cacheKey) ?? null;

  const configPath = join(root, "config.ts");
  try {
    await stat(configPath);
  } catch {
    configCache.set(cacheKey, null);
    return null;
  }

  try {
    const mod = await import(configPath);
    const config = (mod.collections ?? mod.default) as CollectionsConfig;
    configCache.set(cacheKey, config);
    return config;
  } catch (err) {
    console.warn("[nix-js-kit] Failed to load content config:", err);
    configCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Clears the in-memory cache for all collections. Called by the HMR handler
 * when a `.md` file changes.
 */
export function clearContentCache(): void {
  collectionCache.clear();
  configCache.clear();
}

/**
 * Scans a collection directory and returns all entries. Nested directories
 * are scanned recursively; the slug of a nested file includes its relative
 * sub-path (e.g. `getting-started/intro` for `getting-started/intro.md`).
 */
async function scanCollection(
  name: string,
  collectionDir: string,
  validator: SchemaValidator | undefined,
): Promise<ContentEntry[]> {
  let files: string[];
  try {
    files = await readdir(collectionDir, { recursive: true });
  } catch {
    return [];
  }

  const mdFiles = files.filter((f) => f.endsWith(".md"));
  const entries: ContentEntry[] = [];

  for (const file of mdFiles) {
    const filePath = join(collectionDir, file);
    const slug = file.slice(0, -3).replace(/\\/g, "/");
    const source = await readFile(filePath, "utf8");
    const { data: rawData, body } = parseDocument(source);

    const data = validator ? validator(rawData, filePath) : rawData;

    entries.push({
      collection: name,
      slug,
      data,
      body,
      filePath,
    });
  }

  // Sort by date descending if a `date` field exists, otherwise by slug.
  entries.sort((a, b) => {
    const dateA = (a.data as Record<string, unknown>)?.date;
    const dateB = (b.data as Record<string, unknown>)?.date;
    if (dateA instanceof Date && dateB instanceof Date) {
      return dateB.getTime() - dateA.getTime();
    }
    return a.slug.localeCompare(b.slug);
  });

  return entries;
}

/**
 * Returns all entries in a collection.
 *
 * @param name Collection name (directory under `src/content/`).
 *
 * Per plan §11.4: collection names are validated for containment — no
 * path traversal or escape from the content root is allowed.
 */
export async function getCollection<TData = Record<string, unknown>>(
  name: string,
): Promise<ContentEntry<TData>[]> {
  // Containment check: reject names that could escape the content root.
  if (!isValidCollectionName(name)) {
    throw new Error(`[nix-js-kit] Invalid collection name: "${name}". Collection names must be alphanumeric with hyphens/underscores only.`);
  }

  const root = resolveContentRoot();
  const collectionDir = join(root, name);

  // Verify the resolved path is still inside the content root.
  const resolvedDir = resolve(collectionDir);
  const resolvedRoot = resolve(root);
  if (!resolvedDir.startsWith(resolvedRoot + "/") && resolvedDir !== resolvedRoot) {
    throw new Error(`[nix-js-kit] Collection "${name}" escapes the content root.`);
  }

  const cached = collectionCache.get(`${root}:${name}`);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.entries as ContentEntry<TData>[];
  }

  const config = await loadCollectionsConfig(root);
  const def = config?.[name];
  const validator = def ? createValidator(def.schema) : undefined;

  const entries = await scanCollection(name, collectionDir, validator);
  collectionCache.set(`${root}:${name}`, { entries, loadedAt: Date.now() });
  return entries as ContentEntry<TData>[];
}

/**
 * Validates that a collection name is safe (no path traversal, no special chars).
 * Per plan §11.4: containment of collection names.
 */
function isValidCollectionName(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  // Only allow alphanumeric, hyphens, and underscores.
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return false;
  // Reject names that could be path segments (., .., etc).
  if (name === "." || name === "..") return false;
  return true;
}

/**
 * Returns a single entry by slug, or `undefined` if not found.
 *
 * @param collection Collection name.
 * @param slug Entry slug (filename without `.md`).
 */
export async function getEntry<TData = Record<string, unknown>>(
  collection: string,
  slug: string,
): Promise<ContentEntry<TData> | undefined> {
  const entries = await getCollection<TData>(collection);
  return entries.find((e) => e.slug === slug);
}

/**
 * Returns multiple entries by slug.
 *
 * @param collection Collection name.
 * @param slugs Array of slugs.
 */
export async function getEntries<TData = Record<string, unknown>>(
  collection: string,
  slugs: string[],
): Promise<ContentEntry<TData>[]> {
  const entries = await getCollection<TData>(collection);
  const slugSet = new Set(slugs);
  return entries.filter((e) => slugSet.has(e.slug));
}

/**
 * Renders the Markdown body of an entry to HTML. The result is cached on the
 * entry object so repeated calls don't re-render.
 *
 * @throws If `marked` is not installed.
 */
export async function renderEntryHTML(entry: ContentEntry): Promise<string> {
  if (entry.html) return entry.html;
  const html = await renderMarkdown(entry.body);
  entry.html = html;
  return html;
}
