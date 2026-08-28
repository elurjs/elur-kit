//
// The <!DOCTYPE>, <head> and <body> wrapper — plus the serialized loader data
// and the client entry — are injected here at build time.

import type { PageMetadata } from "../types.js";
export interface ShellOptions {
  /** Rendered inner HTML that goes inside `#app`. */
  body: string;
  /** `<title>` text. */
  title?: string;
  /** `<html lang>` attribute. */
  lang?: string;
  /** Additional attributes for the `<html>` element, e.g. `{ "data-theme": "dark" }`. */
  htmlAttributes?: Record<string, string>;
  /**
   * Inline scripts injected into `<head>`. They run synchronously while the
   * document parses — before the first paint and before the (deferred) client
   * bundle — so they are the right place for no-flash bootstrapping (e.g.
   * applying a stored theme before the page becomes visible).
   */
  headScripts?: string[];
  /**
   * Raw HTML strings injected into `<head>` — e.g. `<link rel="icon">`,
   * `<link rel="manifest">`, `<meta name="theme-color">`. Each string is
   * rendered as-is inside `<head>`.
   */
  headLinks?: string[];
  /** Loader data serialized into `<script id="elur-data">`. */
  data?: unknown;
  /** Per-page action names serialized into `<script id="elur-actions">`. */
  actions?: Record<string, string[]>;
  /** Path to the client entry module, e.g. `/_elur/entry-client.js`. */
  clientEntry?: string;
  /** Page metadata emitted as `<meta>`, `<link>` and OG/Twitter tags in `<head>`. */
  metadata?: PageMetadata;
  /**
   * Whether the SSR render endpoint (`/__elur-js/render`) is available at
   * runtime. Defaults to `true`. When `false` (static deployments), the shell
   * emits `<meta name="elur:render-endpoint" content="off" />` so the client
   * router skips probing the endpoint entirely — preventing a storm of 404
   * requests on fully static sites.
   */
  renderEndpoint?: boolean;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Serializes data for embedding inside a `<script>` tag. Escapes `<` so a
 * `</script>` sequence in the data cannot break out of the tag.
 */
function serializeData(data: unknown): string {
  return JSON.stringify(data ?? null).replace(/</g, "\\u003c");
}

/**
 * Builds the `<head>` tags for a `PageMetadata` object. Every tag is marked with
 * `data-elur-head` so the client-side router can replace them on navigation
 * without touching charset/viewport or user-supplied `headScripts`.
 */
export function buildHeadTags(metadata: PageMetadata, fallbackTitle: string): string {
  const tags: string[] = [];
  const title = metadata.title ?? fallbackTitle;
  if (metadata.title) {
    tags.push(`<title data-elur-head>${escapeHtml(title)}</title>`);
  }

  if (metadata.description) {
    tags.push(`<meta data-elur-head name="description" content="${escapeHtml(metadata.description)}" />`);
  }

  if (metadata.canonical) {
    tags.push(`<link data-elur-head rel="canonical" href="${escapeHtml(metadata.canonical)}" />`);
  }

  if (metadata.robots) {
    tags.push(`<meta data-elur-head name="robots" content="${escapeHtml(metadata.robots)}" />`);
  }

  const og = metadata.openGraph;
  if (og) {
    if (og.type) tags.push(`<meta data-elur-head property="og:type" content="${escapeHtml(og.type)}" />`);
    tags.push(`<meta data-elur-head property="og:title" content="${escapeHtml(og.title ?? title)}" />`);
    if (og.description ?? metadata.description) {
      tags.push(`<meta data-elur-head property="og:description" content="${escapeHtml(og.description ?? metadata.description!)}" />`);
    }
    if (og.url ?? metadata.canonical) {
      tags.push(`<meta data-elur-head property="og:url" content="${escapeHtml(og.url ?? metadata.canonical!)}" />`);
    }
    if (og.image) tags.push(`<meta data-elur-head property="og:image" content="${escapeHtml(og.image)}" />`);
    if (og.image && og.imageAlt) tags.push(`<meta data-elur-head property="og:image:alt" content="${escapeHtml(og.imageAlt)}" />`);
    if (og.image && og.imageWidth) tags.push(`<meta data-elur-head property="og:image:width" content="${String(og.imageWidth)}" />`);
    if (og.image && og.imageHeight) tags.push(`<meta data-elur-head property="og:image:height" content="${String(og.imageHeight)}" />`);
    if (og.image && og.imageType) tags.push(`<meta data-elur-head property="og:image:type" content="${escapeHtml(og.imageType)}" />`);
    if (og.siteName) tags.push(`<meta data-elur-head property="og:site_name" content="${escapeHtml(og.siteName)}" />`);
    if (og.locale) tags.push(`<meta data-elur-head property="og:locale" content="${escapeHtml(og.locale)}" />`);
  }

  const tw = metadata.twitter;
  if (tw) {
    if (tw.card) tags.push(`<meta data-elur-head name="twitter:card" content="${escapeHtml(tw.card)}" />`);
    if (tw.title ?? title) tags.push(`<meta data-elur-head name="twitter:title" content="${escapeHtml(tw.title ?? title)}" />`);
    if (tw.description ?? metadata.description) {
      tags.push(`<meta data-elur-head name="twitter:description" content="${escapeHtml(tw.description ?? metadata.description!)}" />`);
    }
    if (tw.image) tags.push(`<meta data-elur-head name="twitter:image" content="${escapeHtml(tw.image)}" />`);
    if (tw.image && tw.imageAlt) tags.push(`<meta data-elur-head name="twitter:image:alt" content="${escapeHtml(tw.imageAlt)}" />`);
  }

  if (metadata.other) {
    for (const [name, content] of Object.entries(metadata.other)) {
      tags.push(`<meta data-elur-head name="${escapeHtml(name)}" content="${escapeHtml(content)}" />`);
    }
  }

  return tags.map((t) => `\n    ${t}`).join("");
}

/** Wraps rendered body HTML into a full HTML document. */
export function documentShell(opts: ShellOptions): string {
  const { body, title = "Elur Kit App", lang = "es", data, actions, clientEntry, htmlAttributes, headScripts, headLinks, metadata } = opts;

  const dataScript =
    data !== undefined
      ? `\n    <script type="application/json" id="elur-data">${serializeData(data)}</script>`
      : "";

  const actionsScript = actions && Object.keys(actions).length > 0
    ? `\n    <script type="application/json" id="elur-actions">${serializeData(actions)}</script>`
    : "";

  const entryScript = clientEntry
    ? `\n    <script type="module" src="${escapeHtml(clientEntry)}"></script>`
    : "";

  const htmlAttrs = htmlAttributes
    ? Object.entries(htmlAttributes)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => ` ${escapeHtml(key)}="${escapeHtml(String(value))}"`)
      .join("")
    : "";

  const headScriptsHtml = headScripts
    ? headScripts
      .filter((script) => typeof script === "string" && script.trim().length > 0)
      .map((script) => {
        // If the script is already a complete <script> tag (e.g. JSON-LD),
        // render it as-is without wrapping.
        if (script.trimStart().startsWith("<script")) {
          return `\n    ${script}`;
        }
        return `\n    <script>${script.replace(/<\/script>/gi, "<\\/script>")}</script>`;
      })
      .join("")
    : "";

  const headTags = metadata ? buildHeadTags(metadata, title) : "";
  const titleTag = metadata?.title
    ? "" // already emitted by buildHeadTags
    : `\n    <title>${escapeHtml(title)}</title>`;

  const headLinksHtml = headLinks
    ? headLinks
      .filter((link) => typeof link === "string" && link.trim().length > 0)
      .map((link) => `\n    ${link}`)
      .join("")
    : "";

  const renderEndpointMeta =
    opts.renderEndpoint === false
      ? '\n    <meta name="elur:render-endpoint" content="off" />'
      : "";

  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}"${htmlAttrs}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />${renderEndpointMeta}${titleTag}${headTags}${headLinksHtml}${headScriptsHtml}
  </head>
  <body>
    <div id="app">${body}</div>${dataScript}${actionsScript}${entryScript}
  </body>
</html>
`;
}
