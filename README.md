# Nix.js Kit

[![npm version](https://img.shields.io/npm/v/@deijose/nix-js-kit.svg)](https://www.npmjs.com/package/@deijose/nix-js-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

> Full-stack meta-framework for Nix.js — file-based routing, SSG, SSR, ISR, streaming, islands, actions, content collections, cache adapters, and SPA-like navigation. Zero extra runtime dependencies on the client: Nix.js stays at ~15 KB.

## What is Nix.js Kit?

Nix.js Kit is a meta-framework built on top of [Nix.js](https://nix-js.dev/). It brings conventions similar to Next.js App Router / Astro / SvelteKit to Nix.js:

- `src/app/page.ts` for pages
- `src/app/page.data.ts` for loaders
- `src/app/page.action.ts` for server actions
- `src/app/layout.ts` for layouts
- `src/app/route.ts` for API endpoints
- `src/app/loading.ts` for streaming boundaries
- `src/content/` for Markdown content collections
- `src/islands/` for client-side interactive components

### Key features

- **Routing**: file-based with dynamic segments, optional catch-all `[[...slug]]`, route conflict detection, safe URL decoding, redirects/rewrites/route headers
- **Rendering**: SSG, SSR, ISR with explicit cache policy (public/private/dynamic), streaming with `ReadableStream` (**experimental** — fallback buffered por adapter; ver nota de streaming)
- **Actions**: typed `defineAction()` with input validation, AbortSignal, idempotency, concurrency modes (latest/queue/parallel)
- **Cache**: `CacheAdapter` with filesystem storage, SHA-256 keys, atomic writes, single-flight, stale-while-revalidate, tag-based invalidation
- **Security**: HMAC-signed action error cookies, body limits, CSRF verification, default security headers (CSP, HSTS, X-Frame-Options, etc.), conditional static serving (ETag/Last-Modified)
- **Content**: per-request scope via `AsyncLocalStorage`, collection name containment, frontmatter parser, Markdown rendering
- **SEO**: sitemap generation from route manifest, sitemap index for large sites, robots.txt, JSON-LD with safe escaping
- **Integrations**: typed hooks for `nix-i18n`, `nix-js-auth`, `nix-query`, `nix-js-testing` — without adding them as dependencies
- **CLI**: `dev`, `build`, `preview`, `start`, `check`, `routes`, `doctor`, `adapter`
- **Observability**: structured logger with request ID, Server-Timing, sensitive data redaction
- **Adapters**: Node, Bun, Vercel, Netlify with capability-based deployment

## Installation

```bash
npm install @deijose/nix-js @deijose/nix-js-kit
# or
bun add @deijose/nix-js @deijose/nix-js-kit
```

## Quick example

```ts
// src/app/page.data.ts
import type { PageDataLoad } from "@deijose/nix-js-kit";

export const load: PageDataLoad = async () => {
  return { title: "Hello Nix.js Kit" };
};
```

```ts
// src/app/page.ts
import { html, signal } from "@deijose/nix-js";
import type { PageProps } from "@deijose/nix-js-kit";
import { load } from "./page.data.ts";

export default function HomePage({ data }: PageProps<typeof load>) {
  const liked = signal(false);

  return html`
    <article>
      <h1>${data.title}</h1>
      <button @click=${() => (liked.value = !liked.value)}>
        ${() => (liked.value ? "★ Liked" : "☆ Like")}
      </button>
    </article>
  `;
}
```

At build time, `nix-js-kit` runs the loader and renders the page to static HTML using `renderToString`.

## CLI

After installing, the `nix-js-kit` binary is available in your project:

```bash
nix-js-kit build
nix-js-kit dev
nix-js-kit preview
nix-js-kit start
nix-js-kit adapter vercel
nix-js-kit adapter netlify
nix-js-kit adapter bun
nix-js-kit adapter node
```

By default it looks for `src/app/` and `src/islands/` and writes to `dist/`:

```bash
nix-js-kit build
# → dist/index.html
# → dist/_nix-js/entry-client.js   (after bundling the generated entry)
```

Run the dev server with rebuild-on-change:

```bash
nix-js-kit dev
```

If you have a `vite.client.config.ts`, the client hydration bundle is built automatically. You can still pass an explicit config with `--client-config <path>`.

Serve the production build:

```bash
nix-js-kit build
nix-js-kit preview
```

Run the SSR server (renders pages on demand):

```bash
nix-js-kit build          # generate or update the client bundle
nix-js-kit start
```

Enable ISR with a cache directory and default TTL:

```bash
nix-js-kit start --cache-dir .nix-js/cache --default-revalidate 60
```

Options:

| Flag | Default | Description |
| --- | --- | --- |
| `-r, --root <dir>` | `cwd` | Project root |
| `-a, --app <dir>` | `src/app` | Pages directory relative to root |
| `-i, --islands <dir>` | `src/islands` | Islands directory relative to root |
| `-o, --out <dir>` | `dist` | Output directory relative to root |
| `-p, --port <number>` | `3000` | Server port |
| `-h, --host <address>` | `127.0.0.1` | Server host |
| `-l, --lang <lang>` | `es` | HTML `lang` attribute |
| `--hydrate-import <spec>` | `@deijose/nix-js-kit/island` | Import path for `hydrateIslands` in generated entry |
| `--client-config <path>` | `vite.client.config.ts` (auto-detected) | Vite config used to build the client bundle in dev mode |

## Core features (v2.0)

- **File-based routing** — `src/app/page.ts` maps to URLs with dynamic segments (`[slug]`), catch-all (`[...slug]`), optional catch-all (`[[...slug]]`), route groups `(group)`, and route conflict detection.
- **SSG, SSR, ISR** — static generation, on-demand SSR, and incremental static regeneration with explicit cache policy (`public`/`private`/`dynamic`), SHA-256 cache keys, atomic writes, single-flight, and tag-based invalidation.
- **Streaming (experimental)** — `ReadableStream`-based streaming with `loading.ts` boundaries, `createStreamingResponse()`, and `createBufferedResponse()` fallback for adapters without streaming. **Etiquetado como experimental** hasta completar la matriz de paridad streaming/buffered cross-host y la implementación de `renderToChunks()` en el core.
- **Server actions** — typed `defineAction()` with input validation (`.parse()`), AbortSignal propagation, idempotency metadata, concurrency modes (`latest`/`queue`/`parallel`), and progressive enhancement (plain HTML forms).
- **RequestContext** — per-request context with `params`, `locals`, `cookies` (CookieJar), `signal` (AbortSignal), `requestId`, `platform`, `route`, and mutable `response` state (headers, Set-Cookie, status). Aligned with runtime-security §4.
- **Unified Web handler** — `createWebHandler()` is the single entry point for all runtimes (Node, Bun, Vercel, Netlify, Vite dev **y el CLI `dev`/`preview`**). Every runtime is a thin wrapper; no duplicated routing/actions/static pipelines.
- **Cache security** — `shouldCachePublic()` rejects requests with cookies/Authorization. `isResultCacheable()` rejects HTML with action error markers. No personalized ISR cache leakage.
- **Public error sanitization** — production 500s use `toPublicErrorInfo()`/`publicErrorResponse()` (JSON, `no-store`), never exposing stacks, paths or secrets; request id is kept in internal logs.
- **CSRF protection** — `verifyOrigin()` checks `Origin`, `Referer`, `Host`, and `Sec-Fetch-Site` with allow-list and `strictOrigin` mode.
- **Static serving** — containment-enforced path resolution (rejects traversal, NUL, backslashes, symlinks), ETag/Last-Modified conditional requests, Range/If-Range with 206/416, HEAD sin body, immutable caching for hashed assets.
- **Security headers** — CSP with nonce support, HSTS (HTTPS only), X-Content-Type-Options, Referrer-Policy, X-Frame-Options, Permissions-Policy.
- **Content layer** — per-request scope via `AsyncLocalStorage`, collection name containment (no path traversal), frontmatter parser, Markdown rendering.
- **SEO** — sitemap generation from route manifest, sitemap index for >50,000 URLs, robots.txt, JSON-LD with safe escaping (`<`, `>`, `&`, U+2028, U+2029).
- **Image optimization** — manifest-driven `<picture>` with content-addressed hashed variants, `<source>` per format, real dimensions, no upscales, Sharp optional.
- **Islands** — lazy `import()` per island, null/error isolation, `load`/`idle`/`visible` directives, auto-scan of `src/islands/`.
- **Client router** — AbortController + navigation token (no races), head/assets merge, aria-live announcer, canonical URL, View Transitions with reduced-motion fallback.
- **Middleware** — `src/middleware.ts` with path matchers, `next()` carries params/locals, cleanup in `finally`, runs in dev/preview/adapters.
- **Integrations** — typed hooks for `nix-i18n`, `nix-js-auth`, `nix-query`, `nix-js-testing` without adding them as dependencies.
- **CLI** — `dev`, `build`, `preview`, `start`, `check`, `routes`, `doctor`, `adapter` with reliable exit codes.
- **Observability** — structured logger with request ID, Server-Timing, sensitive data redaction (cookies, auth, tokens).
- **Adapters** — Node, Bun, Vercel, Netlify with relocatable paths (`import.meta.url`) and capability-based deployment.
- **Atomic build** — staging outside `dist/`, Vite JS API (no `npx`), `copyPublicAssets()`, final swap only on success.
- **`throw new Response()`** — first-class HTTP control flow from loaders and layout loaders (redirects, 404, etc.).
- **HMAC-signed action errors** — action error cookies signed with SHA-256, rejects tampered/forged values.

## What's new in v2.1

- **#1: Route-level code-splitting** — the generated client entry uses `import()`
  per island, producing separate chunks per page. Islands not on the current
  page stay out of the initial bundle.
- **#2: Layout Slots** — `*.slot.ts` files (e.g. `sidebar.slot.ts`,
  `header.slot.ts`) are detected by the route scanner and passed to layout
  components as named slots: `Layout({ children, slots: { sidebar, header } })`.
- **#3: Redis / Cloudflare KV cache adapters** —
  `createRedisCacheAdapter()` and `createCloudflareKVCacheAdapter()` for
  serverless and distributed deployments. Same `CacheAdapter` interface as
  the filesystem adapter, with tag-based invalidation.
- **#4: Real Suspense streaming** — `streamBoundary()` now emits a
  `<template>` chunk + replacement script that swaps the fallback `<div>`
  for the resolved content in-place via `replaceWith`, instead of the old
  `innerHTML` append.
- **#5: `happy-dom` optional** — moved from `dependencies` to
  `peerDependenciesMeta.optional`. The SSR runtime loads it via dynamic
  `import()` only when the core renderer needs a DOM fallback.

## What's new in v2.0

- **Breaking: Node >=20.19.0** — dropped Node 18 support. Vite 7/8 and the core engine require Node 20.19+.
- **Breaking: Core v3** — `@deijose/nix-js` peer dependency upgraded to `^3.0.0`. New subpaths `@deijose/nix-js/server` and `@deijose/nix-js/hydrate` for SSR without DOM simulation and real hydration over existing DOM.
- **Breaking: Image pipeline** — `image()` now emits `<picture>` from a content-addressed manifest. No more broken `srcset` URLs. Sharp is optional.
- **Breaking: Config** — `defineConfig()` from `@deijose/nix-js-kit/config`. No `__dirname` in ESM configs.
- **Breaking: Build** — atomic staging, Vite JS API, `copyPublicAssets()`. No partial output on failure.
- **Breaking: Adapters** — relocatable paths via `import.meta.url`. No absolute paths embedded.
- **Security: Path traversal** — `resolveStaticFile()` rejects encoded traversal, NUL, backslashes, Unicode normalization, symlink escape.
- **Security: CSRF** — `verifyOrigin()` checks `Origin`/`Referer`/`Host`/`Sec-Fetch-Site` with allow-list and `strictOrigin`.
- **Security: Cache isolation** — no public caching of personalized responses. HMAC-signed action errors.
- **Security: JSON-LD** — escapes `<`, `>`, `&`, U+2028, U+2029.
- **Security: Body limits** — 413 responses for oversized JSON/form bodies.
- **Security: Public errors (v2.0.2)** — production 500s no longer leak `String(err)`; sanitized JSON via `toPublicErrorInfo()`/`publicErrorResponse()`.
- **Security: Static ranges (v2.0.2)** — `Range`/`If-Range` with 206/416 and uniform HEAD responses.
- **DX: CLI** — `check`, `routes`, `doctor` commands with reliable exit codes.
- **DX: Logger** — structured logger with request ID, Server-Timing, redaction.
- **DX: Scaffold** — `create-nix-app` with `template-kit` option.
- **Images (v2.0.2)** — SHA-256 transform keys, path containment, atomic writes, single-flight, `images.strict`, `getImage()` and `ImageService`.
- **Capabilities (v2.0.2)** — `AdapterCapabilities` per host with build-time `validateCapabilities()`.
- **Islands (v2.0.2)** — discriminated `{ load }` lazy loaders + `lazyIsland()`; loader detection never probes the component.
- **Tests: 442 tests** — unit, integration, security fuzz, cache concurrency, CSRF matrix, package smoke, SSR benchmark, static range, error sanitization, image hardening, capabilities, cross-runtime parity.
- **Audit: 0 vulnerabilities** — `bun audit` clean. `publint` All good.

## What's new in v1.3

- **Security** — CSRF protection via Origin header verification; action errors stored in ephemeral cookie instead of URL params.
- **Metadata API** — `generateMetadata()` in pages, head merge on SPA navigation, scroll restoration on back/forward.
- **Content layer** — typed Markdown collections with YAML frontmatter parser (zero deps), optional `zod` validation, `marked` rendering, `raw()` HTML helper, HMR for `.md` files.
- **Image optimization** — `image()` with responsive srcset/sizes/lazy/fetchpriority; `sharp` pipeline generates WebP/AVIF variants at build time.
- **Prefetch + View Transitions** — IntersectionObserver-based prefetch on viewport + hover/focus; native View Transitions API with reduced-motion fallback.
- **Middleware** — `src/middleware.ts` with `config.matcher`, runs before routing in SSR and Vite dev server.
- **TypeScript 7** — upgraded to the native Go compiler (10x faster typecheck).

## What's new in v1.2

- **Automatic attribute interpolation** — no more manual workarounds for `href="/blog/${slug}"`. The kit rewrites partial interpolations into valid Nix.js single interpolations during build, dev, start, and preview.
- **Client router in the bundle** — the SPA router lives in the generated client entry (`/_nix-js/entry-client.js`) instead of being inlined into every page, keeping the HTML clean and the routing code cacheable.
- **SSR fallback in preview** — `preview` now renders dynamic routes on demand when a static file is missing, so slugs work even without `generateStaticParams`.
- **Auto client bundle build** — when `vite.client.config.ts` is present, `build` and `dev` build the hydration bundle automatically; no `--client-config` flag is required.
- **No server paths in HTML** — the serialized action registry only exposes action names per page (`{"/contact":["subscribe"]}`), never file system paths or implementation details.

## Roadmap

| Version | Focus |
| --- | --- |
| v0.1 | SSG + file-based routing |
| v0.2 | Islands, data loading, actions, API routes |
| v0.3 | CLI + dev server |
| v0.4 | `generateStaticParams`, route groups, preview server |
| v0.5 | SSR runtime + adapter-node |
| v0.6 | Vite plugin + DX improvements |
| v0.7 | Vercel adapter + DX improvements |
| v0.8 | Netlify adapter + Bun adapter |
| v0.9 | Server actions ✅ |
| v1.0 | Stabilization: test suite, error handling ✅, Node adapter ✅, and action DX ✅ |
| v1.1 | Streaming boundaries + ISR ✅ |
| v1.2 | Interpolation plugin, SPA router, preview SSR fallback ✅ |
| v1.3 | Security, metadata API, content layer, image optimization, prefetch, View Transitions, middleware ✅ |
| v2.0 | Core v3 (SSR without Happy DOM, real hydration), atomic build, manifest-driven images, unified Web handler, RequestContext (§4), CSRF/static/cache hardening, CLI commands, structured logger, scaffold, 442 tests, 0 vulnerabilities ✅ |
| v2.0.2 | Cumplimiento: keyed hydration, streaming chunks/protocols (core), static Range/HEAD, errores sanitizados, imágenes hardening + `getImage`/`ImageService`, capabilities, islands `lazyIsland`, E2E Playwright (16 tests) ⏳ unreleased |

## API

### `renderToString(factory)`

Renders a Nix.js template to an HTML string in Node.js.

```ts
import { renderToString } from "@deijose/nix-js-kit";
import HomePage from "./src/app/page";

const body = await renderToString(() => HomePage({ data: { title: "Hi" } }));
```

### `documentShell(options)`

Wraps rendered HTML in a full document shell with `<script id="nix-js-data">`.

```ts
import { documentShell } from "@deijose/nix-js-kit";

const html = documentShell({
  title: "My Page",
  body,
  data: { title: "My Page" },
  clientEntry: "/_nix-js/entry-client.js",
});
```

### Islands

Create an interactive component in `src/islands/`:

```ts
// src/islands/LikeButton.ts
import { html, signal } from "@deijose/nix-js";

export default function LikeButton({ postId }: { postId: string }) {
  const liked = signal(false);
  return html`
    <button @click=${() => (liked.value = !liked.value)}>
      ${() => (liked.value ? "★ Liked" : "☆ Like")}
    </button>
  `;
}
```

Mark it as an island in a page:

```ts
// src/app/page.ts
import { html, island } from "@deijose/nix-js-kit";
import LikeButton from "../islands/LikeButton";

export default function HomePage() {
  return html`
    <article>
      <h1>Hello</h1>
      ${island("LikeButton", LikeButton, { postId: "123" }, "load")}
    </article>
  `;
}
```

Hydrate it on the client. You can write the entry by hand:

```ts
// src/entry-client.ts
import { hydrateIslands } from "@deijose/nix-js-kit/island";
import LikeButton from "./islands/LikeButton";

hydrateIslands({ LikeButton });
```

Lazy (code-split) islands use a discriminated `{ load }` loader so the hydrator
can tell eager components from lazy loaders **without invoking them** (no probe
side effects):

```ts
import { lazyIsland, hydrateIslands } from "@deijose/nix-js-kit/island";

const registry = {
  LikeButton: lazyIsland(() => import("./islands/LikeButton").then((m) => m.default)),
};
hydrateIslands(registry);
```

…or let `build()` generate it for you by scanning `src/islands/` (see
[Auto island scan](#auto-island-scan) below). Each `.ts` file becomes an island
whose registry name is its path relative to `islandsDir`
(`nav/MobileMenu.ts` → `"nav/MobileMenu"`).

Directives:

| Directive | Hydration trigger |
| --- | --- |
| `load` | Immediately |
| `idle` | `requestIdleCallback` |
| `visible` | `IntersectionObserver` |

### `build(config)`

Scans `src/app/` and generates the full static site in `dist/`. You can call it
from code or use the `nix-js-kit build` CLI (see [CLI](#cli)).

```ts
import { build } from "@deijose/nix-js-kit";

await build({
  appDir: "./src/app",
  outDir: "./dist",
  clientEntry: "/_nix-js/entry-client.js",
  // Optional: auto-generate the hydration entry from src/islands/
  islandsDir: "./src/islands",
  generatedEntry: "./.nix-js/entry-client.ts",
});
```

The scanner recognizes:

| File | URL | Notes |
| --- | --- | --- |
| `src/app/page.ts` | `/` | Home page |
| `src/app/about/page.ts` | `/about` | Static page |
| `src/app/blog/[slug]/page.ts` | `/blog/:slug` | Dynamic route (requires `generateStaticParams`) |
| `src/app/[...slug]/page.ts` | `/:slug*` | Catch-all route (requires `generateStaticParams`) |
| `src/app/(marketing)/about/page.ts` | `/about` | Route group (ignored in URL, can add layout) |
| `src/app/layout.ts` | all children | Root layout |
| `src/app/blog/layout.ts` | `/blog/*` | Nested layout |
| `src/app/(marketing)/layout.ts` | `/pricing`, `/features` | Group layout |
| `src/app/404.page.ts` | error | Custom 404 page (SSG, SSR, adapters) |
| `src/app/500.page.ts` | error | Custom 500 page (SSG, SSR, adapters) |

### Dynamic routes with `generateStaticParams`

Dynamic routes are skipped during SSG unless the page exports a
`generateStaticParams` function. It returns an array of param objects, one per
static HTML file to generate:

```ts
// src/app/blog/[slug]/page.ts
import { html } from "@deijose/nix-js";
import type { PageProps, GenerateStaticParams } from "@deijose/nix-js-kit";
import { load } from "./page.data.ts";

export const generateStaticParams: GenerateStaticParams = async () => {
  return [{ slug: "hello-world" }, { slug: "nix-js-kit" }];
};

export default function BlogPostPage({ data, params }: PageProps<typeof load>) {
  return html`
    <article>
      <h1>${data.title}</h1>
      <p>Slug: ${params.slug}</p>
    </article>
  `;
}
```

```ts
// src/app/blog/[slug]/page.data.ts
import type { PageDataLoad } from "@deijose/nix-js-kit";

export const load: PageDataLoad = async ({ params }) => {
  return { title: `Post: ${params.slug}` };
};
```

Running `nix-js-kit build` then produces:

```
dist/blog/hello-world/index.html
dist/blog/nix-js-kit/index.html
```

Catch-all routes use a string array for the spread param:

```ts
export const generateStaticParams = async () => {
  return [{ slug: ["docs", "intro"] }]; // -> /docs/intro
};
```

### Server actions

Create a `page.action.ts` file next to a `page.ts` and export async functions.
They run on the server and can be called from the client with `callAction()` or
`nixJsAction()`:

```ts
// src/app/contact/page.action.ts
export async function submitContact(data: { name: string; email: string }) {
  // validate, write to DB, send email, etc.
  return { ok: true };
}
```

```ts
// src/app/contact/page.ts or any island
import { nixJsAction } from "@deijose/nix-js-kit/action";

const contact = nixJsAction("submitContact", { page: "/contact" });

// inside a template
html`
  <form @submit=${(e: Event) => {
    e.preventDefault();
    contact.submit({ name: "Ada", email: "ada@example.com" });
  }}>
    <input name="name" />
    <input name="email" />
    <button type="submit" disabled=${() => contact.pending.value}>
      ${() => (contact.pending.value ? "Sending..." : "Send")}
    </button>
  </form>
  ${() => contact.error.value ? html`<p>${contact.error.value.message}</p>` : null}
  ${() => contact.data.value ? html`<p>Sent!</p>` : null}
`
```

`nixJsAction` returns a reactive handle with:

- `submit(input)` — calls the action and updates the signals.
- `pending` — signal that is `true` while the action is running.
- `error` — signal with the last error, or `null`.
- `data` — signal with the last successful result, or `null`.

The `page` option scopes the action to a specific route, avoiding name
collisions between different `page.action.ts` files. If you omit it, the
framework falls back to searching all scanned actions by name.

For lower-level control, use `callAction` directly:

```ts
import { callAction } from "@deijose/nix-js-kit/action";

const result = await callAction("submitContact", { name: "Ada", email: "ada@example.com" }, { page: "/contact" });
```

#### Progressive enhancement

Actions also work without JavaScript. Add hidden fields to a plain HTML form
and POST to `/__nix-js/actions`:

```html
<form action="/__nix-js/actions" method="POST">
  <input type="hidden" name="__nix_js_action_name" value="submitContact" />
  <input type="hidden" name="__nix_js_action_page" value="/contact" />
  <input name="name" />
  <input name="email" />
  <button type="submit">Send</button>
</form>
```

The server runs the action and redirects back to the referring page (or to the
string returned by the action). If the client sends `Accept: application/json`,
the result is returned as JSON instead.

The framework exposes the `POST /__nix-js/actions` endpoint in every server mode
(`dev`, `preview`, `start` and all deployment adapters). The action name is
resolved against the scanned `page.action.ts` modules and its return value is
serialized as JSON.

### Route groups

Folders whose name is wrapped in parentheses are ignored in the URL but can
hold a `layout.ts` that applies to all their children:

```
src/app/
├── (marketing)/
│   ├── layout.ts
│   ├── pricing/
│   │   └── page.ts   # -> /pricing
│   └── features/
│       └── page.ts   # -> /features
```

This is useful for shared layouts that don't affect the public path, such as a
marketing shell that differs from a dashboard shell.

### Error pages

Create optional `src/app/404.page.ts` and `src/app/500.page.ts` files to customize
the response when a route is missing or when a page fails to render:

```ts
// src/app/404.page.ts
import { html } from "@deijose/nix-js";

export default function NotFoundPage() {
  return html`
    <article>
      <h1>404</h1>
      <p>Page not found.</p>
      <a href="/">Back home</a>
    </article>
  `;
}
```

```ts
// src/app/500.page.ts
import { html } from "@deijose/nix-js";

export default function ErrorPage() {
  return html`
    <article>
      <h1>500</h1>
      <p>Something went wrong.</p>
      <a href="/">Back home</a>
    </article>
  `;
}
```

The framework renders these pages:

- During `nix-js-kit build` as `dist/404.html` and `dist/500.html`.
- During `nix-js-kit start` and in the Vite plugin for unmatched routes and render errors.
- In every deployment adapter (`vercel`, `netlify`, `bun`, `node`) for unmatched routes and SSR render failures.

Error pages receive the same `PageProps` as regular pages and can export their own `404.page.data.ts` or `500.page.data.ts` loaders.

### SSR runtime

`nix-js-kit start` runs a Node HTTP server that renders pages on demand,
matching the request URL against the scanned routes and running loaders with
params and search params. Static files are served from the output directory
first, so the client bundle and other assets keep working:

```bash
nix-js-kit build          # build the client bundle and any static files
nix-js-kit start          # SSR server on http://127.0.0.1:3000
```

You can also use the lower-level API to embed the SSR server in a custom Node
app:

```ts
import { createSsrServer } from "@deijose/nix-js-kit";

const ssr = await createSsrServer({
  appDir: "./src/app",
  publicDir: "./dist",
  clientEntry: "/_nix-js/entry-client.js",
  port: 3000,
});
await ssr.listen();
```

### Vite plugin

The official Vite plugin gives you a Vite-native dev server with SSR rendering
and automatic island entry generation:

```ts
import { defineConfig } from "vite";
import { nixJsKit } from "@deijose/nix-js-kit/vite";

export default defineConfig({
  plugins: [nixJsKit()],
});
```

Then run the Vite dev server:

```bash
npx vite
```

The plugin scans `src/app/`, writes `.nix-js/entry-client.ts` and renders every
page on demand. For production, keep using `nix-js-kit build` to generate static
HTML and the client bundle.

### Adapters

Deploy to Vercel with the built-in adapter. First build the site, then generate
the Vercel output:

```bash
nix-js-kit build
nix-js-kit adapter vercel
```

This produces a `.vercel/output` directory that includes:

- `static/` — the static files from `dist/`.
- `functions/__nix-js-kit.func/index.js` — a bundled SSR function for unmatched routes.
- `config.json` — Vercel Build Output API v3 routing config.

You can also use the adapter programmatically:

```ts
import { vercelAdapter } from "@deijose/nix-js-kit/adapters/vercel";

await vercelAdapter.build({
  root: process.cwd(),
  appDir: "src/app",
  islandsDir: "src/islands",
  outDir: "dist",
  clientEntry: "/_nix-js/entry-client.js",
  lang: "es",
});
```

### Netlify adapter

Deploy to Netlify with the built-in adapter:

```bash
nix-js-kit build
nix-js-kit adapter netlify
```

This produces:

- `netlify/functions/__nix-js-kit.mjs` — bundled SSR function for Netlify Functions v2.
- `netlify.toml` — redirects unmatched routes to the function.

The static files stay in `dist/` and are served directly by Netlify. Programmatic usage:

```ts
import { netlifyAdapter } from "@deijose/nix-js-kit/adapters/netlify";

await netlifyAdapter.build({
  root: process.cwd(),
  appDir: "src/app",
  islandsDir: "src/islands",
  outDir: "dist",
  clientEntry: "/_nix-js/entry-client.js",
  lang: "es",
});
```

### Bun adapter

Run a production server with Bun:

```bash
nix-js-kit build
nix-js-kit adapter bun
bun run .nix-js/bun-server.ts
```

This generates:

- `.nix-js/bun-index.ts` — SSR handler entry.
- `.nix-js/bun-server.ts` — Bun server that serves `dist/` static files and renders pages on demand.

The server respects the `PORT` environment variable (default `3000`). Programmatic usage:

```ts
import { bunAdapter } from "@deijose/nix-js-kit/adapters/bun";

await bunAdapter.build({
  root: process.cwd(),
  appDir: "src/app",
  islandsDir: "src/islands",
  outDir: "dist",
  clientEntry: "/_nix-js/entry-client.js",
  lang: "es",
});
```

### Node adapter

Run a production server with Node (>=20.19.0):

```bash
nix-js-kit build
nix-js-kit adapter node
node .nix-js/node-server.mjs
```

This generates a single bundled `.nix-js/node-server.mjs` that serves `dist/` static files and renders pages on demand. The server respects the `PORT` environment variable (default `3000`). Programmatic usage:

```ts
import { nodeAdapter } from "@deijose/nix-js-kit/adapters/node";

await nodeAdapter.build({
  root: process.cwd(),
  appDir: "src/app",
  islandsDir: "src/islands",
  outDir: "dist",
  clientEntry: "/_nix-js/entry-client.js",
  lang: "es",
});
```

### Auto island scan

When you pass `islandsDir` and `generatedEntry`, `build()` walks the islands
directory and writes a client entry that imports every island and registers it
with `hydrateIslands`. Point your bundler (Vite/Rollup) at the generated file:

```ts
await build({
  appDir: "./src/app",
  outDir: "./dist",
  clientEntry: "/_nix-js/entry-client.js",
  islandsDir: "./src/islands",
  generatedEntry: "./.nix-js/entry-client.ts",
});
```

Given `src/islands/LikeButton.ts` and `src/islands/nav/MobileMenu.ts`, the
generated `.nix-js/entry-client.ts` looks like:

```ts
// AUTO-GENERATED by @deijose/nix-js-kit. Do not edit.
import { hydrateIslands } from "@deijose/nix-js-kit/island";
import LikeButton_0 from "../src/islands/LikeButton";
import MobileMenu_1 from "../src/islands/nav/MobileMenu";

hydrateIslands({
  "LikeButton": LikeButton_0,
  "nav/MobileMenu": MobileMenu_1,
});
```

The `build()` result also reports the discovered islands:

```ts
const result = await build({ /* ... */ });
result.islands;        // [{ name: "LikeButton", filePath: "…" }, …]
result.generatedEntry; // absolute path to the generated entry
```

You can also call the lower-level helpers directly:

```ts
import { scanIslands, generateClientEntry } from "@deijose/nix-js-kit";

const islands = await scanIslands("./src/islands");
await generateClientEntry({ islands, outFile: "./.nix-js/entry-client.ts" });
```

### Metadata API

Pages can export a `generateMetadata` function or return a `metadata` field
from loaders. The framework generates `<title>`, `<meta>`, `<link>`, OpenGraph
and Twitter card tags, all marked with `data-nix-js-head` so the SPA router
can swap them on navigation.

```ts
// src/app/blog/[slug]/page.ts
import type { PageMetadata } from "@deijose/nix-js-kit";

export const generateMetadata = async ({ params }): Promise<PageMetadata> => {
  return {
    title: `Blog: ${params.slug}`,
    description: "A blog post",
    canonical: `https://example.com/blog/${params.slug}`,
    openGraph: { type: "article", image: "/og/blog.jpg" },
    twitter: { card: "summary_large_image" },
  };
};
```

You can also return `metadata` from a loader:

```ts
// src/app/page.data.ts
export const load = async () => {
  return { title: "Home", metadata: { title: "My Site — Home" } };
};
```

### Content layer

Typed Markdown collections with YAML frontmatter. Define collections in
`src/content/config.ts` and query them from loaders:

```ts
// src/content/config.ts
import { defineCollection } from "@deijose/nix-js-kit/content";

export const collections = {
  blog: defineCollection({ /* schema: z.object({ title: z.string() }) */ }),
};
```

```ts
// src/app/blog/[slug]/page.data.ts
import { getEntry } from "@deijose/nix-js-kit/content";

export const load = async ({ params }) => {
  const post = await getEntry("blog", params.slug);
  if (!post) throw new Response("Not Found", { status: 404 });
  return { post };
};
```

```ts
// src/app/blog/[slug]/page.ts
import { raw } from "@deijose/nix-js-kit/content";
import { renderEntryHTML } from "@deijose/nix-js-kit/content";

export default function BlogPost({ data }) {
  return html`
    <article>
      <h1>${data.post.data.title}</h1>
      ${raw(await renderEntryHTML(data.post))}
    </article>
  `;
}
```

Optional peer dependencies:
- `marked` — Markdown rendering (`renderMarkdown`, `renderEntryHTML`)
- `zod` — schema validation (`defineCollection({ schema: z.object(...) })`)

### Image optimization

The `image()` helper emits responsive `<img>` tags with `srcset`, `sizes`,
lazy loading, and CLS-preventing `width`/`height`:

```ts
import { image } from "@deijose/nix-js-kit";

export default function HeroPage() {
  return html`
    ${image({
      src: "/images/hero.jpg",
      alt: "Hero image",
      width: 1920,
      height: 1080,
      widths: [640, 1280, 1920],
      sizes: "100vw",
      priority: true, // above-the-fold: eager load, fetchpriority="high"
    })}
  `;
}
```

When `sharp` is installed (optional peer dep), `build()` automatically
generates WebP and AVIF variants at the requested widths with content-based
hashing for indefinite caching.

The image pipeline (v2.0.2) is hardened:

- **SHA-256 transform keys** — a variant's hash incorporates the source content
  digest + normalized transform options + encoder/naming versions, so changing
  quality or encoder invalidates the URL as required.
- **Path containment** — sources and outputs are validated against traversal,
  NUL, separators and symlink escape; no reads/writes outside allowed roots.
- **Atomic writes + single-flight** — variants are written via temp+rename with
  a bounded concurrency pool and one in-flight transform per key.
- **`images.strict`** — fails the build on a missing source or failed transform
  instead of emitting a partially-written variant.

Programmatic API:

```ts
import { getImage, createImageService } from "@deijose/nix-js-kit/image";

const meta = await getImage(
  { src: "/images/hero.jpg", alt: "Hero", widths: [640, 1280], formats: ["avif", "webp"] },
  { publicDir: "public", outDir: "dist" },
);
// meta.sources, meta.generated, meta.attributes ...

const service = createImageService({ publicDir: "public", outDir: "dist" });
// service.resolve(request, ctx); service.capabilities ...
```

### Adapter capabilities

Each adapter declares an explicit capability contract used for build-time
diagnostics (runtime-security §8.5):

```ts
interface AdapterCapabilities {
  streaming: boolean;
  filesystem: "none" | "readonly" | "persistent" | "ephemeral";
  imageRuntime: boolean;
  backgroundWork: boolean;
  maxBodySize?: number;
}
```

- `DEFAULT_CAPABILITIES` (Node/Bun), `SERVERLESS_CAPABILITIES` (Vercel/Netlify),
  `EDGE_CAPABILITIES` and `createCapabilities()` are exported from
  `@deijose/nix-js-kit/runtime`.
- `validateCapabilities(caps, { isr, images, streaming })` is checked by the
  CLI `adapter` command so incompatible host+feature combinations fail at build.

### Middleware

Create `src/middleware.ts` to run logic before every request (auth, redirects,
header injection):

```ts
import type { Middleware } from "@deijose/nix-js-kit";

const middleware: Middleware = (request) => {
  if (!request.headers.get("Cookie")?.includes("session=")) {
    return Response.redirect(new URL("/login", request.url), 307);
  }
};

export default middleware;

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*"],
};
```

### Prefetch and View Transitions

The SPA router automatically prefetches pages when links enter the viewport
(IntersectionObserver) and on hover/focus. Prefetched pages are cached for
30 seconds. Add `data-no-prefetch` to any link to opt out.

When the browser supports the View Transitions API, page transitions use
`document.startViewTransition()` for smooth cross-fade animations. This is
automatically disabled when the user has `prefers-reduced-motion: reduce`.

## Project conventions

```text
my-app/
├── src/
│   ├── app/
│   │   ├── layout.ts        # root layout
│   │   ├── page.ts          # home page
│   │   ├── page.data.ts     # home loader
│   │   ├── page.action.ts   # home server actions
│   │   ├── 404.page.ts      # custom 404 page
│   │   ├── 500.page.ts      # custom 500 page
│   │   ├── blog/
│   │   │   ├── page.ts
│   │   │   ├── page.data.ts
│   │   │   └── page.action.ts
│   │   └── api/
│   │       └── posts/
│   │           └── route.ts # API endpoint
│   ├── content/             # content layer (Markdown collections)
│   │   ├── config.ts        # collection definitions
│   │   └── blog/
│   │       ├── hello-world.md
│   │       └── second-post.md
│   └── islands/             # interactive components
├── middleware.ts            # optional middleware (auth, redirects)
├── nix.config.ts
└── vite.config.ts
```

## License

MIT © Deiver Vasquez
