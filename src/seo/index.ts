/**
 * SEO utilities — sitemap.xml and robots.txt generation.
 *
 * @module
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

// Types

export interface SitemapEntry {
  /** URL path, e.g. "/docs/getting-started/introduction". */
  url: string;
  /** Last modification date (ISO 8601 or YYYY-MM-DD). */
  lastmod?: string;
  /** Change frequency: always, hourly, daily, weekly, monthly, yearly, never. */
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  /** Priority 0.0–1.0. */
  priority?: number;
}

export interface SitemapConfig {
  /** Base URL of the site, e.g. "https://example.com". */
  siteUrl: string;
  /** List of URL entries to include in the sitemap. */
  urls: (SitemapEntry | string)[];
  /** Output directory where sitemap.xml will be written. */
  outDir: string;
}

export interface RobotsConfig {
  /** Base URL of the site, e.g. "https://example.com". */
  siteUrl: string;
  /** Output directory where robots.txt will be written. */
  outDir: string;
  /** Rules for specific user agents. */
  rules?: RobotsRule[];
  /** Paths to disallow for all crawlers (shorthand for rules). */
  disallow?: string[];
  /** Sitemap URL override. If not set, defaults to `${siteUrl}/sitemap.xml`. */
  sitemapUrl?: string;
}

export interface RobotsRule {
  /** User-agent, e.g. "Googlebot" or "*" for all. */
  userAgent: string;
  /** Paths to disallow. */
  disallow?: string[];
  /** Paths to allow. */
  allow?: string[];
  /** Crawl delay in seconds. */
  crawlDelay?: number;
}

// Sitemap generation

/**
 * Generates a `sitemap.xml` file from a list of URLs.
 *
 * @example
 * ```ts
 * import { generateSitemap } from "@deijose/nix-js-kit/seo";
 *
 * await generateSitemap({
 *   siteUrl: "https://nix-js-kit.dev",
 *   outDir: "./dist",
 *   urls: [
 *     "/",
 *     "/docs/introduction",
 *     { url: "/docs/routing", changefreq: "weekly", priority: 0.8 },
 *   ],
 * });
 * ```
 */
export async function generateSitemap(config: SitemapConfig): Promise<string> {
  const { siteUrl, urls, outDir } = config;
  const base = siteUrl.replace(/\/$/, "");

  const entries: string[] = urls.map((entry) => {
    const e = typeof entry === "string" ? { url: entry } : entry;
    const loc = `${base}${e.url.startsWith("/") ? "" : "/"}${e.url}`;
    const lines = [`  <url>`, `    <loc>${escapeXml(loc)}</loc>`];
    if (e.lastmod) lines.push(`    <lastmod>${e.lastmod}</lastmod>`);
    if (e.changefreq) lines.push(`    <changefreq>${e.changefreq}</changefreq>`);
    if (e.priority !== undefined) lines.push(`    <priority>${e.priority.toFixed(1)}</priority>`);
    lines.push(`  </url>`);
    return lines.join("\n");
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>
`;

  const filePath = join(outDir, "sitemap.xml");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, xml, "utf8");
  return filePath;
}

// Robots.txt generation

/**
 * Generates a `robots.txt` file.
 *
 * @example
 * ```ts
 * import { generateRobots } from "@deijose/nix-js-kit/seo";
 *
 * await generateRobots({
 *   siteUrl: "https://nix-js-kit.dev",
 *   outDir: "./dist",
 *   disallow: ["/api/", "/_nix-js/"],
 * });
 * ```
 */
export async function generateRobots(config: RobotsConfig): Promise<string> {
  const { siteUrl, outDir, rules, disallow, sitemapUrl } = config;
  const base = siteUrl.replace(/\/$/, "");
  const lines: string[] = [];

  if (rules && rules.length > 0) {
    for (const rule of rules) {
      lines.push(`User-agent: ${rule.userAgent}`);
      if (rule.allow) {
        for (const path of rule.allow) lines.push(`Allow: ${path}`);
      }
      if (rule.disallow) {
        for (const path of rule.disallow) lines.push(`Disallow: ${path}`);
      }
      if (rule.crawlDelay !== undefined) {
        lines.push(`Crawl-delay: ${rule.crawlDelay}`);
      }
      lines.push("");
    }
  } else {
    lines.push("User-agent: *");
    if (disallow && disallow.length > 0) {
      for (const path of disallow) lines.push(`Disallow: ${path}`);
    } else {
      lines.push("Disallow:");
    }
    lines.push("");
  }

  const sitemap = sitemapUrl ?? `${base}/sitemap.xml`;
  lines.push(`Sitemap: ${sitemap}`);

  const content = lines.join("\n") + "\n";
  const filePath = join(outDir, "robots.txt");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return filePath;
}

// JSON-LD / Structured data

export interface JsonLdSchema {
  [key: string]: unknown;
}

/**
 * Serializes a JSON-LD structured data object into a `<script type="application/ld+json">` tag.
 *
 * @example
 * ```ts
 * import { jsonLd } from "@deijose/nix-js-kit/seo";
 *
 * const schema = jsonLd({
 *   "@context": "https://schema.org",
 *   "@type": "TechArticle",
 *   headline: "Routing",
 *   author: { "@type": "Person", name: "Deiver Vasquez" },
 * });
 * // Returns: <script type="application/ld+json">{...}</script>
 * ```
 */
export function jsonLd(schema: JsonLdSchema | JsonLdSchema[]): string {
  const data = JSON.stringify(Array.isArray(schema) ? schema : schema);
  // Escape sequences that could close the <script> tag or introduce markup.
  // Per the HTML spec, inside a <script> block the only dangerous sequence
  // is "</script" (case-insensitive). We also escape "<" more broadly to
  // prevent any interpreter from seeing markup-like content, and escape
  // "<!--" to prevent HTML comment-based escapes.
  const safe = data
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script type="application/ld+json">${safe}</script>`;
}

// Helpers

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
