// --- CLI output formatting ---
//
// Lightweight colored output without extra dependencies. Colors are enabled
// only when stdout is a TTY and NO_COLOR is not set (https://no-color.org).
//
// Message shape (sober, Vite/Astro style):
//   ✓ message            success
//     → message          info / pointer
//   ! message            warning
//   ✗ message            error
//   [tag] message        lifecycle events (dev supervisor)
//
// `--quiet` suppresses everything except errors.

import { networkInterfaces } from "node:os";

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code: number, text: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const bold = (text: string): string => paint(1, text);
export const dim = (text: string): string => paint(2, text);
export const red = (text: string): string => paint(31, text);
export const green = (text: string): string => paint(32, text);
export const yellow = (text: string): string => paint(33, text);
export const cyan = (text: string): string => paint(36, text);

let quiet = false;

/** Enables quiet mode: only errors are printed. */
export function setQuiet(value: boolean): void {
  quiet = value;
}

/** Success message with a green check. */
export function success(message: string): void {
  if (quiet) return;
  console.log(`${green("✓")} ${message}`);
}

/** Indented info line with a cyan arrow. */
export function info(message: string): void {
  if (quiet) return;
  console.log(`  ${cyan("→")} ${message}`);
}

/** Indented detail line (file lists, sub-items). */
export function detail(message: string): void {
  if (quiet) return;
  console.log(dim(`  - ${message}`));
}

/** Lifecycle event with a dim bracket tag, e.g. [dev], [change]. */
export function event(tag: string, message: string): void {
  if (quiet) return;
  console.log(`${dim(`[${tag}]`)} ${message}`);
}

/** Warning; suppressed in quiet mode. */
export function warn(message: string): void {
  if (quiet) return;
  console.warn(`${yellow("!")} ${message}`);
}

/** Error; always printed, even in quiet mode. */
export function error(message: string): void {
  console.error(`${red("✗")} ${message}`);
}

/** Formats a byte count as "640 B", "1.5 kB", "2.3 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Formats a duration as "45ms" or "1.23s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Build phase line: checkmark + label + dim duration. */
export function phase(label: string, durationMs: number): void {
  if (quiet) return;
  console.log(`  ${green("✓")} ${label} ${dim(formatDuration(durationMs))}`);
}

export interface FileEntry {
  path: string;
  bytes: number;
}

const MAX_FILE_ROWS = 20;
const SHOWN_FILE_ROWS = 10;

/**
 * Renders the generated-file list as aligned "path  size" rows (plain text,
 * no color). With more than MAX_FILE_ROWS entries, shows the SHOWN_FILE_ROWS
 * largest plus a "… and N more" line.
 */
export function fileRows(files: FileEntry[], max = MAX_FILE_ROWS, shown = SHOWN_FILE_ROWS): string[] {
  const sorted = files.length > max
    ? [...files].sort((a, b) => b.bytes - a.bytes)
    : files;
  const visible = sorted.slice(0, files.length > max ? shown : sorted.length);
  const pathWidth = Math.max(...visible.map((f) => f.path.length), 0);
  const sizeWidth = Math.max(...visible.map((f) => formatBytes(f.bytes).length), 0);
  const rows = visible.map(
    (f) => `${f.path.padEnd(pathWidth)}  ${formatBytes(f.bytes).padStart(sizeWidth)}`,
  );
  const hidden = files.length - visible.length;
  if (hidden > 0) rows.push(`… and ${hidden} more`);
  return rows;
}

/** Prints the generated-file list: dim paths, aligned sizes. */
export function fileList(files: FileEntry[]): void {
  if (quiet || files.length === 0) return;
  for (const row of fileRows(files)) {
    const sizeMatch = /^(.*?)(  \S+)$/.exec(row);
    if (sizeMatch) {
      console.log(`  ${dim(sizeMatch[1])} ${dim(sizeMatch[2])}`);
    } else {
      console.log(`  ${dim(row)}`);
    }
  }
}

export interface ServerBannerOptions {
  name: string;
  version: string;
  /** Command label, e.g. "dev" or "preview". */
  command: string;
  localUrl: string;
  networkUrl?: string;
}

/**
 * Plain-text lines of the server startup banner (Astro-style, no box):
 *
 *   elur-kit v2.4.10 dev server running at:
 *     → Local:    http://localhost:3000/
 *     → Network:  http://192.168.1.20:3000/
 */
export function serverBannerLines(options: ServerBannerOptions): string[] {
  const lines = [
    `${options.name} ${options.version} ${options.command} server running at:`,
    "",
  ];
  const labelWidth = options.networkUrl ? "Network:".length : "Local:".length;
  lines.push(`  → ${"Local:".padEnd(labelWidth)} ${options.localUrl}`);
  if (options.networkUrl) {
    lines.push(`  → ${"Network:".padEnd(labelWidth)} ${options.networkUrl}`);
  }
  return lines;
}

/** Prints the server startup banner with brand colors. */
export function serverBanner(options: ServerBannerOptions): void {
  if (quiet) return;
  const [title, blank, ...urls] = serverBannerLines(options);
  console.log();
  console.log(`  ${bold(cyan(title))}`);
  console.log(blank);
  for (const line of urls) {
    const arrowEnd = line.indexOf("→") + 1;
    console.log(`  ${cyan("→")}${dim(line.slice(arrowEnd))}`);
  }
}

/** First external (LAN) IPv4 address, for the Network URL. */
export function getNetworkAddress(): string | undefined {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return undefined;
}
