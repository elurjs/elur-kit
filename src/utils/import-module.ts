import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Imports an absolute file path through a file:// URL.
 *
 * Node's ESM loader rejects Windows paths like `D:\project\file.js`
 * (ERR_UNSUPPORTED_ESM_URL_SCHEME); pathToFileURL produces the portable
 * `file:///D:/project/file.js` form on every platform. Bare package
 * specifiers are passed through unchanged.
 */
export function importFile<T = unknown>(path: string): Promise<T> {
  const specifier = isAbsolute(path) ? pathToFileURL(path).href : path;
  return import(specifier) as Promise<T>;
}
