import { mkdir, rm, rename, stat, cp, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { build as viteBuild, type InlineConfig, type PluginOption } from "vite";
import { nixJsInterpolationPlugin, shouldUseLegacyInterpolation, type InterpolationMode } from "../vite/interpolation-plugin.js";

// --- Programmatic Vite build orchestration ---
//
// Replaces the previous `spawnSync("npx", ["vite", "build", ...])` approach
// with direct use of the Vite JavaScript API. Benefits:
//
//   * No child-process overhead or `npx` resolution latency.
//   * Shared module cache across build phases (faster large builds).
//   * Structured errors instead of exit-code parsing.
//   * Atomic output staging: build into a temp directory, then rename to the
//     final destination so a crashed build never leaves a half-written dist.

export interface ClientBuildOptions {
  /** Project root (absolute). */
  root: string;
  /** Absolute path to the user's Vite client config (e.g. vite.client.config.ts). */
  userConfigPath: string;
  /** Absolute path to the app directory (used by the interpolation plugin). */
  appDir: string;
  /** Absolute path to the islands directory (used by the interpolation plugin). */
  islandsDir: string;
  /** Output directory for the client bundle (absolute). */
  outDir: string;
  /** Optional base path. */
  base?: string;
  /** Optional log prefix. */
  logPrefix?: string;
  /**
   * How the legacy interpolation transform is handled (default: "auto").
   * With a Nix.js core that supports partial attribute interpolation natively
   * the transform is not applied; use "legacy" for migrations against older
   * cores and "off" to never transform.
   */
  interpolation?: InterpolationMode;
}

export interface ClientBuildResult {
  /** Output directory (same as `outDir` input). */
  outDir: string;
  /** Number of chunks/assets emitted, if reported by Vite. */
  outputCount: number;
}

/**
 * Build the client hydration bundle using the Vite JavaScript API.
 *
 * The user's config is loaded programmatically and the nix-js interpolation
 * plugin is injected so partial attribute interpolations inside islands are
 * transformed before reaching the browser.
 */
export async function buildClientBundle(options: ClientBuildOptions): Promise<ClientBuildResult> {
  const log = options.logPrefix ?? "[client]";
  console.log(`${log} Building hydration bundle...`);

  const userConfig = await loadUserConfig(options.userConfigPath, options.root);
  const pluginOptions: PluginOption = shouldUseLegacyInterpolation(options.interpolation ?? "auto")
    ? nixJsInterpolationPlugin({
        appDir: options.appDir,
        islandsDir: options.islandsDir,
      })
    : [];

  const config: InlineConfig = {
    ...userConfig,
    root: options.root,
    base: options.base ?? userConfig.base ?? "/",
    build: {
      ...(userConfig.build ?? {}),
      outDir: options.outDir,
      emptyOutDir: true,
    },
    plugins: [...(userConfig.plugins ?? []), pluginOptions],
    configFile: false,
  };

  const result = await viteBuild(config);
  const outputs = Array.isArray(result) ? result : [result];
  const outputCount = outputs.reduce(
    (n, r) => n + ("output" in r ? (r.output?.length ?? 0) : 0),
    0,
  );
  console.log(`${log} ✓ ${outputCount} asset(s) emitted → ${relative(options.root, options.outDir)}`);
  return { outDir: options.outDir, outputCount };
}

async function loadUserConfig(path: string, _root: string): Promise<InlineConfig> {
  const mod = await import(path);
  const raw = mod.default ?? mod;
  const resolved = typeof raw === "function" ? await raw({ command: "build", mode: "production" }) : raw;
  return (resolved && typeof resolved.then === "function" ? await resolved : resolved) ?? {};
}

// --- Atomic output staging ---

export interface AtomicStageOptions {
  /** Final destination directory (absolute). */
  outDir: string;
  /** Build into this temp directory first, then rename to `outDir`. */
  tempDir?: string;
  /** Whether to preserve existing content in `outDir` during the swap. */
  keepExisting?: boolean;
}

export interface AtomicStage {
  tempDir: string;
  /** Call after the build succeeds to atomically swap temp → outDir. */
  commit: () => Promise<void>;
  /** Call on failure to clean up the temp directory. */
  rollback: () => Promise<void>;
}

/**
 * Prepare an atomic staging directory for build output.
 *
 * Usage:
 *   const stage = await beginAtomicStage({ outDir });
 *   try {
 *     await buildInto(stage.tempDir);
 *     await stage.commit();
 *   } catch (err) {
 *     await stage.rollback();
 *     throw err;
 *   }
 */
export async function beginAtomicStage(options: AtomicStageOptions): Promise<AtomicStage> {
  const outDir = resolve(options.outDir);
  const tempDir = resolve(options.tempDir ?? join(dirname(outDir), `.${basename(outDir)}.tmp-${process.pid}`));

  // Start from a clean temp directory.
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  const commit = async () => {
    // Backup the existing output if requested, then swap.
    const backup = options.keepExisting && existsSync(outDir) ? `${outDir}.bak-${process.pid}` : undefined;
    if (backup) {
      await rm(backup, { recursive: true, force: true });
      await safeRename(outDir, backup);
    }
    try {
      await safeRename(tempDir, outDir);
    } catch (err) {
      // On some platforms, renaming across mount points fails. Fall back to a
      // recursive copy + clean, which is not atomic but still correct.
      if (isCrossDevice(err)) {
        await cp(tempDir, outDir, { recursive: true, force: true });
        await rm(tempDir, { recursive: true, force: true });
      } else {
        if (backup) await safeRename(backup, outDir);
        throw err;
      }
    }
    if (backup) await rm(backup, { recursive: true, force: true });
  };

  const rollback = async () => {
    await rm(tempDir, { recursive: true, force: true });
  };

  return { tempDir, commit, rollback };
}

function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "output";
}

async function safeRename(src: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  try {
    await rename(src, dest);
  } catch (err) {
    if (isCrossDevice(err)) {
      await cp(src, dest, { recursive: true, force: true });
      await rm(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

function isCrossDevice(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EXDEV";
}

// --- Public asset copy ---

export interface CopyPublicAssetsOptions {
  /** Absolute path to the public directory. */
  publicDir: string;
  /** Absolute path to the output directory. */
  outDir: string;
}

/**
 * Copy the public directory into the output directory.
 * Returns the number of files copied.
 */
export async function copyPublicAssets(options: CopyPublicAssetsOptions): Promise<number> {
  try {
    await access(options.publicDir);
    const s = await stat(options.publicDir);
    if (!s.isDirectory()) return 0;
  } catch {
    return 0;
  }
  await mkdir(options.outDir, { recursive: true });
  await cp(options.publicDir, options.outDir, { recursive: true, force: true });
  return countFiles(options.outDir);
}

async function countFiles(dir: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let count = 0;
  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) await walk(path);
      else count++;
    }
  }
  await walk(dir);
  return count;
}
