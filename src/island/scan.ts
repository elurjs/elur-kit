import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

// --- Island scanner ---
//
// Walks `src/islands/` and lists every island component module. Each `.ts`
// file (recursively) is treated as one island whose name is derived from its
// path relative to the islands root:
//
//   src/islands/LikeButton.ts        -> "LikeButton"
//   src/islands/nav/MobileMenu.ts    -> "nav/MobileMenu"
//
// The name must match the first argument passed to `island(name, ...)` on the
// server so the client registry can look the component up during hydration.

/** A single island component discovered by the scanner. */
export interface IslandModule {
  /** Registry name, derived from the path relative to the islands dir. */
  name: string;
  /** Absolute file system path to the island module. */
  filePath: string;
}

async function walk(dir: string): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = (await readdir(dir, {
      withFileTypes: true,
      encoding: "utf8",
    })) as Dirent<string>[];
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

function toIslandName(islandsDir: string, filePath: string): string {
  return relative(islandsDir, filePath)
    .replace(/\.ts$/, "")
    .split(sep)
    .join("/");
}

/**
 * Scans an islands directory for island component modules.
 *
 * @param islandsDir Absolute path to the islands directory (e.g. "src/islands").
 * @returns Discovered island modules, sorted by name.
 */
export async function scanIslands(islandsDir: string): Promise<IslandModule[]> {
  const files = await walk(islandsDir);
  return files
    .map((filePath) => ({ name: toIslandName(islandsDir, filePath), filePath }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
