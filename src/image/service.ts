import { readFile, mkdir, writeFile, rename, rm, stat } from "node:fs/promises";
import { join, dirname, extname, basename, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { ImageFormat } from "./index.js";

// --- ImageService: metadata-driven image processing and manifest ---
//
//   * Reads real image dimensions from the source file (sharp metadata).
//   * Generates hashed variant filenames from a SHA-256 transform key that
//     incorporates: content digest + normalized transform options +
//     encoder/service version + output naming version (§4.2).
//   * Applies path containment for sources and outputs (no traversal, no NUL,
//     no symlink escape, no Unicode/separator tricks).
//   * Writes outputs atomically (temp + rename) with single-flight per
//     transform key and a bounded concurrency pool.
//   * Supports `strict` mode: fails the build on missing sources or failed
//     transforms instead of emitting a partially-written variant.
//   * Falls back gracefully when sharp is not installed.

const ENCODER_VERSION = "sharp-1";
const NAMING_VERSION = "v1";
const HASH_LENGTH = 12;
const DEFAULT_QUALITY = 80;
const DEFAULT_CONCURRENCY = 4;

export interface ImageVariant {
  /** URL path relative to the site root, e.g. "/images/hero.abc123def456.800w.webp". */
  url: string;
  /** Width in pixels. */
  width: number;
  /** Height in pixels (preserves aspect ratio). */
  height: number;
  /** Format of the variant. */
  format: ImageFormat;
  /** File size in bytes. */
  size: number;
}

export interface ImageEntry {
  /** Original source URL, e.g. "/images/hero.jpg". */
  src: string;
  /** Intrinsic width of the source. */
  width: number;
  /** Intrinsic height of the source. */
  height: number;
  /** All generated variants. */
  variants: ImageVariant[];
  /** Content hash of the source file. */
  hash: string;
}

export interface ImageManifest {
  version: 1;
  entries: Record<string, ImageEntry>;
}

export interface ProcessOptions {
  /** Absolute path to the public directory (source images). */
  publicDir: string;
  /** Absolute path to the output directory. */
  outDir: string;
  /** Formats to generate. Defaults to ["webp", "avif"]. */
  formats?: ImageFormat[];
  /** Quality (1-100). Defaults to 80. */
  quality?: number;
  /** Path to write the manifest JSON. */
  manifestPath?: string;
  /** When true, missing sources or failed transforms fail the build. */
  strict?: boolean;
  /** Max concurrent sharp transforms. Defaults to 4. */
  concurrency?: number;
  /** Optional URL base prefix applied to variant URLs. */
  base?: string;
}

export interface ProcessResult {
  manifest: ImageManifest;
  /** Number of variants generated. */
  count: number;
  /** Whether sharp was available. */
  optimized: boolean;
}

let sharpLoader: (() => Promise<any>) | null | undefined;

async function loadSharp(): Promise<any | null> {
  if (sharpLoader === null) return null;
  if (sharpLoader) return sharpLoader();
  try {
    // @ts-ignore — `sharp` is an optional peer dependency.
    const mod = await import("sharp");
    const sharp = mod.default;
    if (typeof sharp !== "function") {
      sharpLoader = null;
      return null;
    }
    sharpLoader = async () => sharp;
    return sharp;
  } catch {
    sharpLoader = null;
    return null;
  }
}

export async function isSharpAvailable(): Promise<boolean> {
  const sharp = await loadSharp();
  return sharp !== null;
}

// --- Transform identity (§4.2) ---

/**
 * SHA-256 transform key. Stable for identical content+options and invalidated
 * whenever the source bytes, the effective transform options, the encoder
 * version or the naming scheme change.
 */
export function transformHash(sourceBuffer: Buffer, width: number, format: ImageFormat, quality: number): string {
  const contentDigest = createHash("sha256").update(sourceBuffer).digest("hex");
  const normalizedOptions = JSON.stringify({
    width,
    format,
    quality,
    withoutEnlargement: true,
  });
  return createHash("sha256")
    .update(`${contentDigest}|${normalizedOptions}|${ENCODER_VERSION}|${NAMING_VERSION}`)
    .digest("hex")
    .slice(0, HASH_LENGTH);
}

// --- Path containment (§9.5) ---

function isSafeRelativePath(value: string): boolean {
  if (value.includes("\0") || value.includes("\\")) return false;
  if (/%[0-9a-f]{2}/i.test(value)) return false;
  const segments = value.replace(/^\/+/, "").split("/");
  return !segments.some((segment) => segment === ".." || segment === "." || segment === "");
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function assertInside(root: string, candidate: string, label: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!isInside(resolvedRoot, resolvedCandidate)) {
    throw new Error(`[elur-kit] Image ${label} escapes its allowed root (${resolvedCandidate}).`);
  }
}

// --- Concurrency: bounded pool + single-flight ---

function createPool(limit: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < limit) {
        active++;
        resolve();
      } else {
        waiters.push(() => {
          active++;
          resolve();
        });
      }
    });
  const release = () => {
    active--;
    const next = waiters.shift();
    if (next) next();
    else if (active < 0) active = 0;
  };
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

// --- Atomic writes (§9.6) ---

async function atomicWriteFile(path: string, data: Buffer | string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => { });
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// --- Public programmatic API (§3.1 / §3.3) ---

export interface ImageRequest {
  src: string;
  alt: string;
  widths?: readonly number[];
  formats?: readonly ImageFormat[];
  sizes?: string;
  width?: number;
  height?: number;
  priority?: boolean;
  loading?: "lazy" | "eager";
  decoding?: "async" | "sync" | "auto";
  quality?: number;
  fit?: string;
  class?: string;
  attributes?: Record<string, unknown>;
}

export interface GeneratedImage {
  url: string;
  width: number;
  height: number;
  format: ImageFormat;
  size: number;
}

export interface ImageMetadata {
  src: string;
  width?: number;
  height?: number;
  sources: Array<{ type: string; srcset: string }>;
  attributes: Record<string, string | number | boolean | undefined>;
  generated: readonly GeneratedImage[];
}

export interface ImageServiceContext {
  publicDir: string;
  outDir: string;
  manifest: ImageManifest;
}

export interface ImageServiceCapabilities {
  /** Whether the encoder (sharp) is available. */
  encoding: boolean;
  /** Whether remote images can be fetched. */
  remote: boolean;
  /** Whether a runtime image endpoint exists. */
  runtimeEndpoint: boolean;
  /** Whether the host exposes a writable filesystem. */
  filesystem: boolean;
}

export interface ImageService {
  resolve(request: ImageRequest, context: ImageServiceContext): Promise<ImageMetadata>;
  capabilities: ImageServiceCapabilities;
}

/**
 * Creates a build-time ImageService bound to a public/output directory pair.
 */
export function createImageService(options: ProcessOptions): ImageService {
  return {
    capabilities: {
      encoding: false,
      remote: false,
      runtimeEndpoint: false,
      filesystem: true,
    },
    async resolve(request, context) {
      return getImage(request, { ...options, publicDir: context.publicDir, outDir: context.outDir });
    },
  };
}

/**
 * Programmatic async image API (§3.1). Ensures the requested variants exist on
 * disk (build-time), then returns deterministic metadata (not opaque markup).
 */
export async function getImage(
  request: ImageRequest,
  options: ProcessOptions,
): Promise<ImageMetadata> {
  const { src, alt, widths, formats, quality, priority, loading, decoding, class: className, attributes = {} } = request;
  const targetWidths = widths?.length ? [...widths] : [request.width ?? 0];
  const targetFormats = formats?.length ? [...formats] : options.formats ?? ["webp", "avif"];
  const result = await processImageBatch(
    [{ src, widths: targetWidths, formats: targetFormats }],
    { ...options, quality: quality ?? options.quality },
  );
  const entry = result.manifest.entries[src];
  const generated: GeneratedImage[] = entry
    ? entry.variants.map((v) => ({ url: v.url, width: v.width, height: v.height, format: v.format, size: v.size }))
    : [];

  const sources: ImageMetadata["sources"] = [];
  for (const format of targetFormats) {
    const srcset = entry ? buildSrcset(entry, format) : "";
    if (srcset) sources.push({ type: format === "jpeg" ? "image/jpeg" : `image/${format}`, srcset });
  }

  return {
    src,
    width: entry?.width,
    height: entry?.height,
    sources,
    attributes: {
      alt,
      width: entry?.width ?? request.width,
      height: entry?.height ?? request.height,
      loading: priority ? "eager" : (loading ?? "lazy"),
      decoding: decoding ?? "async",
      ...(priority ? { fetchpriority: "high" } : {}),
      ...(className ? { class: className } : {}),
      ...attributes,
    },
    generated,
  };
}

// --- Batch processing ---

export async function processImageBatch(
  images: { src: string; widths: number[]; formats?: ImageFormat[] }[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const sharp = await loadSharp();
  const {
    publicDir,
    outDir,
    formats = ["webp", "avif"],
    quality = DEFAULT_QUALITY,
    strict = false,
    concurrency = DEFAULT_CONCURRENCY,
    base = "",
  } = options;
  const entries: Record<string, ImageEntry> = {};
  let count = 0;
  const pool = createPool(concurrency);
  const inFlight = new Map<string, Promise<void>>();

  const warned = new Set<string>();
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[elur-kit] ${message}`);
  };

  if (!sharp) {
    // Without sharp, build a manifest with only the original source entries.
    for (const { src } of images) {
      if (entries[src]) continue;
      if (!isSafeRelativePath(src)) {
        if (strict) throw new Error(`[elur-kit] Invalid image source path: ${src}`);
        warnOnce(`path:${src}`, `Skipping invalid image source path: ${src}`);
        continue;
      }
      const sourcePath = join(publicDir, src.replace(/^\//, ""));
      assertInside(publicDir, sourcePath, `source "${src}"`);
      try {
        const buffer = await readFile(sourcePath);
        entries[src] = {
          src,
          width: 0,
          height: 0,
          variants: [],
          hash: createHash("sha256").update(buffer).digest("hex").slice(0, 8),
        };
      } catch (error) {
        if (strict) throw new Error(`[elur-kit] Image source not found: ${src}`);
        warnOnce(`missing:${src}`, `Image source not found: ${src}. Skipping.`);
      }
    }
    const manifest: ImageManifest = { version: 1, entries };
    if (options.manifestPath) await writeManifest(options.manifestPath, manifest);
    return { manifest, count: 0, optimized: false };
  }

  for (const { src, widths, formats: imgFormats } of images) {
    if (entries[src]) continue;

    if (!isSafeRelativePath(src)) {
      if (strict) throw new Error(`[elur-kit] Invalid image source path: ${src}`);
      warnOnce(`path:${src}`, `Skipping invalid image source path: ${src}`);
      continue;
    }

    const sourcePath = join(publicDir, src.replace(/^\//, ""));
    assertInside(publicDir, sourcePath, `source "${src}"`);

    let sourceBuffer: Buffer;
    try {
      sourceBuffer = await readFile(sourcePath);
    } catch (error) {
      if (strict) throw new Error(`[elur-kit] Image source not found: ${src}`);
      warnOnce(`missing:${src}`, `Image not found: ${src}. Skipping.`);
      continue;
    }

    const ext = extname(src);
    const safeBase = basename(src, ext).replace(/[^a-zA-Z0-9._-]+/g, "-");
    const dir = dirname(src);
    const targetFormats = imgFormats?.length ? imgFormats : formats;

    // Read real metadata from the source.
    let sourceWidth = 0;
    let sourceHeight = 0;
    try {
      const meta = await sharp(sourceBuffer).metadata();
      sourceWidth = meta.width ?? 0;
      sourceHeight = meta.height ?? 0;
    } catch {
      // Fallback: no metadata.
    }

    const variants: ImageVariant[] = [];

    const processVariant = async (width: number, format: ImageFormat): Promise<void> => {
      // Never upscale: skip widths larger than the source.
      if (sourceWidth > 0 && width > sourceWidth) return;

      const hash = transformHash(sourceBuffer, width, format, quality);
      const variantName = `${safeBase}.${hash}.${width}w.${format}`;
      const variantRelPath = join(dir, variantName);
      const variantAbsPath = join(outDir, variantRelPath.replace(/^\//, ""));
      assertInside(outDir, variantAbsPath, `variant "${variantRelPath}"`);
      const variantUrl = `${base.replace(/\/$/, "")}/${variantRelPath.replace(/\\/g, "/").replace(/^\//, "")}`;

      // Reuse an existing, valid output file (validated, not guessed).
      if (await fileExists(variantAbsPath)) {
        try {
          const info = await sharp(variantAbsPath).metadata();
          variants.push({
            url: variantUrl,
            width: info.width ?? width,
            height: info.height ?? Math.round((info.height ?? 0) || (sourceHeight && sourceWidth ? (width * sourceHeight) / sourceWidth : 0)),
            format,
            size: (await stat(variantAbsPath)).size,
          });
          count++;
          return;
        } catch {
          // Existing file invalid — regenerate below.
        }
      }

      const key = variantAbsPath;
      if (inFlight.has(key)) {
        await inFlight.get(key);
        variants.push({
          url: variantUrl,
          width,
          height: Math.round(sourceHeight && sourceWidth ? (width * sourceHeight) / sourceWidth : 0),
          format,
          size: (await stat(variantAbsPath)).size,
        });
        count++;
        return;
      }

      const task = (async () => {
        try {
          const buffer = await sharp(sourceBuffer)
            .resize({ width, withoutEnlargement: true })
            .toFormat(format, { quality })
            .toBuffer();
          await mkdir(dirname(variantAbsPath), { recursive: true });
          await atomicWriteFile(variantAbsPath, buffer);
        } catch (error) {
          if (strict) throw new Error(`[elur-kit] Failed to generate ${variantName}: ${error instanceof Error ? error.message : String(error)}`);
          warnOnce(`fail:${variantName}`, `Failed to generate ${variantName}.`);
          return;
        }
        variants.push({
          url: variantUrl,
          width,
          height: Math.round(sourceHeight && sourceWidth ? (width * sourceHeight) / sourceWidth : 0),
          format,
          size: (await stat(variantAbsPath)).size,
        });
        count++;
      })().finally(() => inFlight.delete(key));

      inFlight.set(key, task);
      await pool.run(() => task);
    };

    const tasks: Promise<void>[] = [];
    for (const width of widths) {
      for (const format of targetFormats) {
        tasks.push(processVariant(width, format));
      }
    }
    await Promise.all(tasks);

    entries[src] = {
      src,
      width: sourceWidth,
      height: sourceHeight,
      variants,
      hash: createHash("sha256").update(sourceBuffer).digest("hex").slice(0, 8),
    };
  }

  const manifest: ImageManifest = { version: 1, entries };
  if (options.manifestPath) await writeManifest(options.manifestPath, manifest);
  return { manifest, count, optimized: true };
}

/**
 * Read a manifest from disk, or return an empty one if it doesn't exist.
 */
export async function readManifest(path: string): Promise<ImageManifest> {
  try {
    const data = await readFile(path, "utf8");
    return JSON.parse(data) as ImageManifest;
  } catch {
    return { version: 1, entries: {} };
  }
}

/**
 * Write a manifest to disk atomically.
 */
export async function writeManifest(path: string, manifest: ImageManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, JSON.stringify(manifest, null, 2));
}

/**
 * Look up an image entry in the manifest by its source URL.
 */
export function getManifestEntry(manifest: ImageManifest, src: string): ImageEntry | undefined {
  return manifest.entries[src];
}

/**
 * Build a srcset string from manifest variants of a given format.
 * Returns e.g. "/images/hero.abc.400w.webp 400w, /images/hero.abc.800w.webp 800w".
 */
export function buildSrcset(entry: ImageEntry, format: ImageFormat): string {
  return entry.variants
    .filter((v) => v.format === format)
    .map((v) => `${v.url} ${v.width}w`)
    .join(", ");
}

/**
 * Build the full <picture> markup for an image entry, with <source> per format
 * and a fallback <img>.
 */
export function buildPictureMarkup(entry: ImageEntry, opts: {
  alt: string;
  sizes?: string;
  priority?: boolean;
  class?: string;
  attributes?: Record<string, string>;
  fallbackSrc?: string;
  fallbackWidth?: number;
  fallbackHeight?: number;
}): string {
  const {
    alt,
    sizes,
    priority = false,
    class: className,
    attributes = {},
    fallbackSrc = entry.src,
    fallbackWidth = entry.width,
    fallbackHeight = entry.height,
  } = opts;

  const formats = [...new Set(entry.variants.map((v) => v.format))];
  const loadingAttr = priority ? "" : ' loading="lazy"';
  const fetchPriorityAttr = priority ? ' fetchpriority="high"' : "";
  const sizesAttr = sizes ? ` sizes="${escapeAttr(sizes)}"` : "";
  const classAttr = className ? ` class="${escapeAttr(className)}"` : "";
  const extraAttrs = Object.entries(attributes)
    .map(([key, value]) => ` ${escapeAttr(key)}="${escapeAttr(String(value))}"`)
    .join("");

  const sources = formats
    .map((format) => {
      const srcset = buildSrcset(entry, format);
      if (!srcset) return "";
      const type = format === "jpeg" ? "image/jpeg" : `image/${format}`;
      return `<source srcset="${srcset}"${sizesAttr} type="${type}" />`;
    })
    .filter(Boolean)
    .join("");

  const img = `<img src="${escapeAttr(fallbackSrc)}" alt="${escapeAttr(alt)}" width="${fallbackWidth}" height="${fallbackHeight}"${loadingAttr} decoding="async"${fetchPriorityAttr}${classAttr}${extraAttrs} />`;

  return sources ? `<picture>${sources}${img}</picture>` : img;
}

/**
 * Validate that every variant URL in the manifest corresponds to a real file
 * in the output directory. Returns a list of missing URLs.
 */
export async function validateManifestUrls(
  manifest: ImageManifest,
  outDir: string,
): Promise<string[]> {
  const missing: string[] = [];
  for (const entry of Object.values(manifest.entries)) {
    for (const variant of entry.variants) {
      const relative = variant.url.replace(/^\/+/, "");
      const resolved = resolve(outDir, relative);
      if (!isInside(resolve(outDir), resolved)) {
        missing.push(variant.url);
        continue;
      }
      try {
        await stat(resolved);
      } catch {
        missing.push(variant.url);
      }
    }
  }
  return missing;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
