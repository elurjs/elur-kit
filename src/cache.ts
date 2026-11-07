import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { renameWithRetry } from "./utils/fs-atomic.js";

export interface CacheEntry {
  html: string;
  generatedAt: number;
  revalidate: number;
}

export interface CacheOptions {
  cacheDir: string;
  defaultRevalidate?: number;
}

function cachePath(cacheDir: string, pathname: string): string {
  const key = createHash("sha256").update(pathname).digest("hex");
  return join(cacheDir, `${key}.html.json`);
}

export async function getCachedHtml(
  cacheDir: string,
  pathname: string,
): Promise<CacheEntry | undefined> {
  const path = cachePath(cacheDir, pathname);
  try {
    const raw = await readFile(path, "utf8");
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() - entry.generatedAt < entry.revalidate * 1000) {
      return entry;
    }
  } catch {
    // cache miss or invalid
  }
  return undefined;
}

export async function setCachedHtml(
  cacheDir: string,
  pathname: string,
  html: string,
  revalidate: number,
): Promise<void> {
  const path = cachePath(cacheDir, pathname);
  await mkdir(dirname(path), { recursive: true });
  const entry: CacheEntry = { html, generatedAt: Date.now(), revalidate };
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(entry), "utf8");
    await renameWithRetry(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function isStale(cacheDir: string, pathname: string): Promise<boolean> {
  const path = cachePath(cacheDir, pathname);
  try {
    const raw = await readFile(path, "utf8");
    const entry = JSON.parse(raw) as CacheEntry;
    return Date.now() - entry.generatedAt >= entry.revalidate * 1000;
  } catch {
    return true;
  }
}

export async function clearCache(cacheDir: string): Promise<void> {
  try {
    await rm(cacheDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
