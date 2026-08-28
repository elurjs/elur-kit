import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { shouldUseLegacyInterpolation, transformPartialInterpolations, type InterpolationMode } from "../vite/interpolation-plugin.js";

export interface TransformProjectOptions {
  root: string;
  appDir: string;
  islandsDir?: string;
  /**
   * Absolute path to the transformed tree root. The tree mirrors the project
   * layout relative to the common ancestor of `appDir`/`islandsDir`, so
   * relative imports between app and islands keep resolving. Relative imports
   * that escape that ancestor are compensated for the added directory depth.
   */
  outDir: string;
  /**
   * How the legacy interpolation transform is handled (default: "auto").
   * With a Elur core that supports partial attribute interpolation natively
   * the transform is not applied; use "legacy" for migrations against older
   * cores and "off" to never transform.
   */
  interpolation?: InterpolationMode;
}

/**
 * Copy app (and optionally islands) source files to a transformed directory,
 * rewriting partial Elur attribute interpolations so they can be imported
 * by the SSG/SSR build without requiring manual syntax changes.
 */
async function collectTsFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectTsFiles(path)));
      } else if (entry.isFile() && extname(path) === ".ts") {
        files.push(path);
      }
    }
    return files;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
}

function segments(rel: string): string[] {
  return rel.split(/[\\/]+/).filter(Boolean);
}

/** Number of path segments in `rel`. */
function depth(rel: string): number {
  return segments(rel).length;
}

/** Common ancestor directory of two paths (both absolute). */
function commonBase(a: string, b: string): string {
  const sa = segments(a);
  const sb = segments(b);
  const prefix: string[] = [];
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    if (sa[i] === sb[i]) prefix.push(sa[i]);
    else break;
  }
  return resolve("/" + prefix.join(sep));
}

/**
 * Absolute path of the transformed app directory inside the mirror tree,
 * matching where `transformProjectFiles` copies the app files.
 */
export function transformedAppDir(
  root: string,
  appDir: string,
  islandsDir: string | undefined,
  outDir: string,
): string {
  const absAppDir = resolve(root, appDir);
  const absIslandsDir = islandsDir ? resolve(root, islandsDir) : absAppDir;
  return resolve(outDir, relative(commonBase(absAppDir, absIslandsDir), absAppDir));
}

/**
 * Rewrites relative import specifiers in non-template regions so they resolve
 * to the same targets from the transformed location.
 *
 * Imports that stay inside the mirrored subtree need no changes. Imports that
 * escape it are moved `delta` levels: a positive delta prepends that many
 * `../`, a negative one strips leading `../` segments.
 */
function compensateRelativeImports(source: string, delta: number, maxUps: number): string {
  if (delta === 0) return source;
  const prepend = "..".repeat(delta) + "/";
  const strip = -delta;
  return source.replace(
    /(?:(\bfrom\s*)|(\bimport\s*\()|(\bimport\s+)|(\bexport\s*\*\s*from\s*))(["'])(\.[^"']*)\5/g,
    (_match, fromKw, importCall, importKw, exportStar, quote, specifier) => {
      let ups = 0;
      let idx = 0;
      while (specifier.startsWith("../", idx)) {
        ups++;
        idx += 3;
      }
      // Imports crossing the mirrored subtree boundary (more `..` than the
      // file's depth below the mirror base) point outside the tree.
      const crosses = ups > maxUps;
      let spec = specifier;
      if (crosses && delta > 0) {
        spec = prepend + spec;
      } else if (crosses && delta < 0) {
        let removed = 0;
        while (removed < strip && spec.startsWith("../")) {
          spec = spec.slice(3);
          removed++;
        }
        if (removed < strip && spec === "..") {
          spec = spec.slice(0, -2);
          removed++;
        }
        if (!spec.startsWith(".")) spec = "./" + spec;
      }
      return (fromKw || importCall || importKw || exportStar) + quote + spec + quote;
    },
  );
}

/**
 * Applies import compensation to every region of `source` that is not inside
 * an `html` template literal, so attribute strings like `from "./x.js"` are
 * never rewritten.
 */
function rewriteImportsOutsideTemplates(source: string, delta: number, maxUps: number): string {
  if (delta === 0) return source;
  let result = "";
  let i = 0;
  while (i < source.length) {
    const htmlIndex = source.indexOf("html", i);
    if (htmlIndex === -1) {
      result += compensateRelativeImports(source.slice(i), delta, maxUps);
      break;
    }
    let j = htmlIndex + 4;
    while (j < source.length && /\s/.test(source[j])) j++;
    if (source[j] !== "`") {
      result += compensateRelativeImports(source.slice(i, htmlIndex + 4), delta, maxUps);
      i = htmlIndex + 4;
      continue;
    }
    result += compensateRelativeImports(source.slice(i, htmlIndex + 4), delta, maxUps);
    // Copy the template literal verbatim (interpolations included).
    let depth = 1;
    let k = j + 1;
    while (k < source.length && depth > 0) {
      const c = source[k];
      if (c === "\\") {
        k += 2;
        continue;
      }
      if (c === "`") {
        depth--;
        if (depth === 0) break;
      }
      if (c === "$" && source[k + 1] === "{") {
        // Jump over the interpolation, honoring nested braces.
        let braceDepth = 1;
        let l = k + 2;
        while (l < source.length && braceDepth > 0) {
          if (source[l] === "{") braceDepth++;
          else if (source[l] === "}") braceDepth--;
          l++;
        }
        k = l;
        continue;
      }
      k++;
    }
    if (k >= source.length) {
      result += source.slice(j);
      break;
    }
    result += source.slice(j, k + 1);
    i = k + 1;
  }
  return result;
}

export async function transformProjectFiles(options: TransformProjectOptions): Promise<void> {
  const { root, appDir, islandsDir, outDir } = options;
  const dirs = islandsDir ? [appDir, islandsDir] : [appDir];
  const files: string[] = [];
  for (const dir of dirs) {
    files.push(...(await collectTsFiles(resolve(root, dir))));
  }

  const absAppDir = resolve(root, appDir);
  const absIslandsDir = islandsDir ? resolve(root, islandsDir) : absAppDir;
  const base = commonBase(absAppDir, absIslandsDir);

  // Transformed files sit `delta` levels further from root than originals.
  const delta = depth(relative(root, outDir)) - depth(relative(root, base));

  for (const file of files) {
    const source = await readFile(file, "utf8");
    let output = source;
    if (source.includes("html`") && shouldUseLegacyInterpolation(options.interpolation ?? "auto")) {
      const transformed = transformPartialInterpolations(source);
      if (transformed !== source) {
        output = transformed;
      }
    }
    const rel = relative(root, file);
    if (rel.startsWith("..")) {
      continue;
    }
    const baseDepth = depth(relative(base, dirname(file)));
    output = rewriteImportsOutsideTemplates(output, delta, baseDepth);
    const outFile = resolve(outDir, relative(base, file));
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, output, "utf8");
  }
}
