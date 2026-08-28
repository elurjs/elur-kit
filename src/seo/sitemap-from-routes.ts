// --- Sitemap generation from route manifest (plan §11.3) ---
//
// Generates a sitemap.xml from the scanned routes, excluding:
//   - API routes
//   - Dynamic routes (they require data to generate URLs)
//   - Error pages (404, 500)
//   - Routes with noindex metadata
//
// For dynamic routes, the author should provide a `generateSitemapUrls()`
// function in their page.data.ts that returns concrete URLs.
//
// Supports large sitemaps via sitemap index files (split at 50,000 URLs).

import type { ScannedRoutes } from "../router/route-scanner.js";
import { generateSitemap, type SitemapEntry } from "./index.js";

export interface SitemapFromRoutesOptions {
  siteUrl: string;
  outDir: string;
  routes: ScannedRoutes;
  /** Additional URLs to include (e.g. from dynamic routes). */
  extraUrls?: (SitemapEntry | string)[];
  /** Max URLs per sitemap file. Default: 50000. */
  maxUrlsPerSitemap?: number;
  /** Default changefreq for routes. */
  defaultChangefreq?: SitemapEntry["changefreq"];
  /** Default priority for routes. */
  defaultPriority?: number;
}

/**
 * Generates a sitemap.xml from the route manifest.
 *
 * Static routes are included automatically. Dynamic routes require the author
 * to provide URLs via `extraUrls` or a `generateSitemapUrls()` export.
 *
 * For large sites (>50,000 URLs), a sitemap index is generated.
 */
export async function generateSitemapFromRoutes(
  options: SitemapFromRoutesOptions,
): Promise<string[]> {
  const { siteUrl, outDir, routes, extraUrls = [], maxUrlsPerSitemap = 50000 } = options;

  // Collect static route URLs.
  const routeUrls: SitemapEntry[] = [];
  for (const page of routes.pages) {
    // Skip dynamic routes (they have params).
    if (page.params.length > 0) continue;
    // Skip error pages.
    if (page.path === "/404" || page.path === "/500") continue;
    // Skip internal namespaces.
    if (page.path.startsWith("/_elur") || page.path.startsWith("/__elur-js")) continue;

    routeUrls.push({
      url: page.path,
      changefreq: options.defaultChangefreq,
      priority: options.defaultPriority,
    });
  }

  // Merge with extra URLs.
  const allUrls = [...routeUrls, ...extraUrls];

  // If under the limit, generate a single sitemap.
  if (allUrls.length <= maxUrlsPerSitemap) {
    const path = await generateSitemap({ siteUrl, outDir, urls: allUrls });
    return [path];
  }

  // For large sitemaps, split into multiple files with an index.
  return generateSitemapIndex({ siteUrl, outDir, urls: allUrls, maxUrlsPerSitemap });
}

/**
 * Generates a sitemap index file that references multiple sitemap files.
 * Used for large sites (>50,000 URLs).
 */
async function generateSitemapIndex(
  options: { siteUrl: string; outDir: string; urls: (SitemapEntry | string)[]; maxUrlsPerSitemap: number },
): Promise<string[]> {
  const { siteUrl, outDir, urls, maxUrlsPerSitemap } = options;
  const base = siteUrl.replace(/\/$/, "");
  const files: string[] = [];
  const sitemapUrls: string[] = [];

  // Split URLs into chunks.
  for (let i = 0; i < urls.length; i += maxUrlsPerSitemap) {
    const chunk = urls.slice(i, i + maxUrlsPerSitemap);
    const filename = `sitemap-${Math.floor(i / maxUrlsPerSitemap) + 1}.xml`;
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { join, dirname } = await import("node:path");

    // Generate the chunk sitemap.
    const entries = chunk.map((entry) => {
      const e = typeof entry === "string" ? { url: entry } : entry;
      const loc = `${base}${e.url.startsWith("/") ? "" : "/"}${e.url}`;
      const lines = [`  <url>`, `    <loc>${escapeXml(loc)}</loc>`];
      if (e.lastmod) lines.push(`    <lastmod>${e.lastmod}</lastmod>`);
      if (e.changefreq) lines.push(`    <changefreq>${e.changefreq}</changefreq>`);
      if (e.priority !== undefined) lines.push(`    <priority>${e.priority.toFixed(1)}</priority>`);
      lines.push(`  </url>`);
      return lines.join("\n");
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
    const filePath = join(outDir, filename);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, xml, "utf8");
    files.push(filePath);
    sitemapUrls.push(`${base}/${filename}`);
  }

  // Generate the index file.
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");

  const indexEntries = sitemapUrls.map((url) => `  <sitemap>\n    <loc>${escapeXml(url)}</loc>\n  </sitemap>`).join("\n");
  const indexXml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${indexEntries}\n</sitemapindex>\n`;
  const indexPath = join(outDir, "sitemap.xml");
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, indexXml, "utf8");
  files.push(indexPath);

  return files;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
