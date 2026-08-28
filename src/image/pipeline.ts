// --- Image pipeline: build-time variant generation with sharp (optional) ---
//
// When `sharp` is installed, the pipeline generates WebP/AVIF variants at
// multiple widths for every image registered during the render pass. Variants
// are written to the output directory with a content-based hash so they can
// be cached indefinitely.
//
// When `sharp` is not installed, the pipeline is a no-op and `image()`
// emits a plain `<img>` with srcset pointing to manually-provided files.

import { readFile, mkdir, stat } from "node:fs/promises";
import { join, dirname, extname, basename } from "node:path";
import { createHash } from "node:crypto";
import type { ImageFormat } from "./index.js";

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

export interface PipelineOptions {
  /** Absolute path to the public directory (source images live here). */
  publicDir: string;
  /** Absolute path to the output directory (variants are written here). */
  outDir: string;
  /** Formats to generate. Defaults to ["webp", "avif"]. */
  formats?: ImageFormat[];
  /** Quality (1-100). Defaults to 80. */
  quality?: number;
}

export interface ProcessedImage {
  /** Original source path (e.g. "/images/hero.jpg"). */
  src: string;
  /** Generated variant paths relative to outDir. */
  variants: { path: string; width: number; format: ImageFormat }[];
}

/**
 * Processes a batch of images: for each image, generates variants at the
 * specified widths and formats using sharp. Returns the list of generated
 * files.
 *
 * If sharp is not installed, returns an empty array and logs a warning once.
 */
export async function processImages(
  images: { src: string; widths: number[]; formats: ImageFormat[] }[],
  options: PipelineOptions,
): Promise<ProcessedImage[]> {
  const sharp = await loadSharp();
  if (!sharp) {
    console.warn(
      "[elur-kit] Image optimization requires `sharp`. Install it with:\n" +
      "  npm install sharp\n" +
      "  # or\n" +
      "  bun add sharp\n" +
      "Skipping image processing — using original files.",
    );
    return [];
  }

  const { publicDir, outDir, formats = ["webp", "avif"], quality = 80 } = options;
  const results: ProcessedImage[] = [];
  let warned = false;

  for (const { src, widths, formats: imgFormats } of images) {
    const sourcePath = join(publicDir, src.replace(/^\//, ""));
    try {
      await stat(sourcePath);
    } catch {
      if (!warned) {
        console.warn(`[elur-kit] Image not found: ${sourcePath}. Skipping.`);
        warned = true;
      }
      continue;
    }

    const buffer = await readFile(sourcePath);
    const hash = createHash("md5").update(buffer).digest("hex").slice(0, 8);
    const ext = extname(src);
    const base = basename(src, ext);
    const dir = dirname(src);

    const variants: { path: string; width: number; format: ImageFormat }[] = [];
    const targetFormats = imgFormats.length > 0 ? imgFormats : formats;

    for (const width of widths) {
      for (const format of targetFormats) {
        const variantName = `${base}-${width}w-${hash}.${format}`;
        const variantRelPath = join(dir, variantName);
        const variantAbsPath = join(outDir, variantRelPath.replace(/^\//, ""));

        try {
          await mkdir(dirname(variantAbsPath), { recursive: true });
          await sharp(buffer)
            .resize({ width, withoutEnlargement: true })
            .toFormat(format, { quality })
            .toFile(variantAbsPath);
          variants.push({ path: variantRelPath, width, format });
        } catch (err) {
          console.warn(`[elur-kit] Failed to generate ${variantName}:`, err);
        }
      }
    }

    if (variants.length > 0) {
      results.push({ src, variants });
    }
  }

  return results;
}

/**
 * Checks whether sharp is available without actually loading it.
 */
export async function isSharpAvailable(): Promise<boolean> {
  const sharp = await loadSharp();
  return sharp !== null;
}
