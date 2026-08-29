# Elur Kit

[![npm version](https://img.shields.io/npm/v/@elurjs/kit.svg)](https://www.npmjs.com/package/@elurjs/kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

> Full-stack framework for Elur — file-based routing, SSG, SSR, ISR, streaming, islands, actions, content collections, cache adapters, and SPA-like navigation. Zero extra runtime dependencies on the client: Elur stays at ~15 KB. Optional build-time compiler lowers `html\`\`` templates to imperative DOM code for ~25–44% faster renders.

## What is Elur Kit?

Elur Kit is a framework built on top of [Elur](https://elur.dev/). It brings conventions similar to Next.js App Router / Astro / SvelteKit to Elur:

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
- **Build-time compiler** (optional, recommended): integrates [`@elurjs/core-compiler`](https://www.npmjs.com/package/@elurjs/core-compiler) via [`@elurjs/vite-plugin-elur`](https://www.npmjs.com/package/@elurjs/vite-plugin-elur) to lower `html\`\`` templates to imperative DOM code at build time — eliminates `detectContext`, `buildHTML`, and both `TreeWalker` passes in runtime
- **Partial attribute interpolation**: `class="btn ${size}"` works out of the box via the Vite plugin's state-machine lexer (or the kit's legacy transform as fallback)
- **Actions**: typed `defineAction()` with input validation, AbortSignal, idempotency, concurrency modes (latest/queue/parallel)
- **Cache**: `CacheAdapter` with filesystem, Redis, and Cloudflare KV storage, SHA-256 keys, atomic writes, single-flight, stale-while-revalidate, tag-based invalidation
- **Security**: HMAC-signed action error cookies, body limits, CSRF verification, default security headers (CSP, HSTS, X-Frame-Options, etc.), conditional static serving (ETag/Last-Modified)
- **Content**: per-request scope via `AsyncLocalStorage`, collection name containment, frontmatter parser, Markdown rendering, recursive nested collections
- **SEO**: sitemap generation from route manifest, sitemap index for large sites, robots.txt, JSON-LD with safe escaping
- **Integrations**: typed hooks for `elur-i18n`, `elur-auth`, `elur-query`, `elur-testing` — without adding them as dependencies
- **CLI**: `dev`, `build`, `preview`, `start`, `check`, `routes`, `doctor`, `adapter`
- **Observability**: structured logger with request ID, Server-Timing, sensitive data redaction
- **Adapters**: Node, Bun, Vercel, Netlify with capability-based deployment

## Installation

```bash
npm install @elurjs/core @elurjs/kit
```

For the best performance, also install the Vite plugin (includes the build-time compiler):

```bash
npm install @elurjs/vite-plugin-elur
```

The plugin is an optional peer dependency. When installed, it activates:

- **Build-time compiler** — lowers `html\`\`` to imperative DOM code
- **Partial attribute interpolation** — state-machine lexer (replaces the kit's legacy transform)
- **HMR with state preservation** — signals, stores, forms, routers survive hot updates
- **Scroll/focus preservation** — restored after re-mount

```bash
# or
bun add @elurjs/core @elurjs/kit @elurjs/vite-plugin-elur
```

## Quick example

```ts
// src/app/page.data.ts
import type { PageDataLoad } from "@elurjs/kit";

export const load: PageDataLoad = async () => {
  return { title: "Hello Elur Kit" };
};
```

```ts
// src/app/page.ts
import { html, signal } from "@elurjs/core";
import type { PageProps } from "@elurjs/kit";
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

At build time, `elur-kit` runs the loader and renders the page to static HTML using `renderToString`.

## CLI

After installing, the `elur-kit` binary is available in your project:

```bash
elur-kit build
elur-kit dev
elur-kit preview
elur-kit start
elur-kit adapter vercel
elur-kit adapter netlify
elur-kit adapter bun
elur-kit adapter node
```

By default it looks for `src/app/` and `src/islands/` and writes to `dist/`:

```bash
elur-kit build
# → dist/index.html
# → dist/_elur/entry-client.js   (after bundling the generated entry)
```

Run the dev server with rebuild-on-change:

```bash
elur-kit dev
```

If you have a `vite.client.config.ts`, the client hydration bundle is built automatically. You can still pass an explicit config with `--client-config <path>`.

Serve the production build:

```bash
elur-kit build
elur-kit preview
```

Run the SSR server (renders pages on demand):

```bash
elur-kit build          # generate or update the client bundle
elur-kit start
```

Enable ISR with a cache directory and default TTL:

```bash
elur-kit start --cache-dir .elur/cache --default-revalidate 60
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
| `--hydrate-import <spec>` | `@elurjs/kit/island` | Import path for `hydrateIslands` in generated entry |
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
- **Content layer** — per-request scope via `AsyncLocalStorage`, collection name containment (no path traversal), frontmatter parser, Markdown rendering, recursive nested collections (`getCollection()` scans subdirectories and derives nested slugs).
- **SEO** — sitemap generation from route manifest, sitemap index for >50,000 URLs, robots.txt, JSON-LD with safe escaping (`<`, `>`, `&`, U+2028, U+2029).
- **Image optimization** — manifest-driven `<picture>` with content-addressed hashed variants, `<source>` per format, real dimensions, no upscales, Sharp optional.
- **Islands** — lazy `import()` per island, null/error isolation, `load`/`idle`/`visible` directives, auto-scan of `src/islands/`.
- **Client router** — AbortController + navigation token (no races), head/assets merge, aria-live announcer, canonical URL, View Transitions with reduced-motion fallback.
- **Middleware** — `src/middleware.ts` with path matchers, `next()` carries params/locals, cleanup in `finally`, runs in dev/preview/adapters.
- **Integrations** — typed hooks for `elur-i18n`, `elur-auth`, `elur-query`, `elur-testing` without adding them as dependencies.
- **CLI** — `dev`, `build`, `preview`, `start`, `check`, `routes`, `doctor`, `adapter` with reliable exit codes.
- **Observability** — structured logger with request ID, Server-Timing, sensitive data redaction (cookies, auth, tokens).
- **Adapters** — Node, Bun, Vercel, Netlify with relocatable paths (`import.meta.url`) and capability-based deployment.
- **Atomic build** — staging outside `dist/`, Vite JS API (no `npx`), `copyPublicAssets()`, final swap only on success.
- **`throw new Response()`** — first-class HTTP control flow from loaders and layout loaders (redirects, 404, etc.).
- **HMAC-signed action errors** — action error cookies signed with SHA-256, rejects tampered/forged values.

## What's new in v2.4

- **Fixed: image pipeline silently no-op** — the CLI bundle was
  inlining its own copy of the image registry, so `consumeImageRegistry()`
  always returned `[]` and the two-pass sharp pipeline never ran (no
  manifest, no variants, no `<picture>`). The registry state is now in a
  dedicated shared chunk (`image/registry.js`) that both the CLI and the
  library import, ensuring a single module instance.
- **`happy-dom` removed from the runtime** — the kit no longer depends on
  happy-dom at runtime. SSR uses the core's DOM-free
  `renderToString` (`@elurjs/core/server`) directly. The legacy DOM
  fallback (`renderWithDom`) was deleted along with all `external`/
  `globals` references in the vite build configs. `happy-dom` is kept
  **only** as a `devDependency` to provide a DOM environment for the
  client-side test suites (`island.test.ts`, `client-router.test.ts`,
  ...); it is never imported by `src/`, never referenced by either vite
  build config, and never shipped in the published bundle (`files`
  contains only `dist/lib`). See
  `test/happy-dom-optional.test.ts` for the guard that enforces this.
- **`raw()` now supports server rendering** — added
  `ELUR_RENDER_PROTOCOL.renderServer` to `raw()` so it works with the
  core's DOM-free SSR (previously relied on the happy-dom fallback).
- **Config file renamed** — `elur.config.ts` → `elur.config.ts`. The
  generic name was a design error that could collide with other tools.
  Legacy `elur.config.*` files still work but emit a deprecation warning.
- **Integration `build` hook** (v2.4.1+) — the `build` hook in
  `ElurKitIntegration` was declared but never invoked. Now `build()` fires
  `runIntegrationHook(integrations, "build", [result, ctx])` after all
  pages, image variants, and the manifest are written. Integrations can
  generate post-build artifacts (sitemaps, robots.txt, search indexes)
  into the output directory. `BuildResult.outDir` (v2.4.2) exposes the
  actual output path (the atomic staging temp dir in CLI mode) so
  artifacts survive the staging commit.
- **Client-only islands** (v2.4.3) — `island()` no longer crashes for
  components that access `document`/`window`/`navigator` in their body
  (carousels, charts, third-party widgets). Two opt-out mechanisms,
  mirroring Astro `client:only` and Next.js `dynamic(..., { ssr: false })`:
  - `directive: "only"` — skip SSR entirely, hydrate on `load`.
  - `options: { ssr: false }` — skip SSR with any directive
    (`load`/`idle`/`visible`).
  - `options: { fallback }` — HTML rendered inside the island marker
    when SSR is skipped or the component returns `null`. Accepts a
    `ElurTemplate` (reactive) or a plain string.
  - `isSSR()` — exported guard for environment reads
    (`window.matchMedia`, `localStorage`, `navigator`). See
    [Islands](#islands) for the limitation on `document.querySelectorAll`.
  SSR errors are never silently swallowed — they propagate wrapped with
  the island name and remediation hints.

#### Using the `build` hook for sitemaps

```ts
// elur.config.ts
import { defineConfig } from "@elurjs/kit";
import { generateSitemap, generateRobots } from "@elurjs/kit/seo";
import type { ElurKitIntegration } from "@elurjs/kit";

const sitemapIntegration: ElurKitIntegration = {
  name: "sitemap",
  build: async (result) => {
    const outDir = (result as { outDir: string }).outDir;
    await generateSitemap({
      siteUrl: "https://example.com",
      outDir,
      urls: [
        { url: "/", priority: 1.0, changefreq: "weekly" },
        { url: "/about", priority: 0.8, changefreq: "monthly" },
      ],
    });
    await generateRobots({ siteUrl: "https://example.com", outDir });
  },
};

export default defineConfig({
  integrations: [sitemapIntegration],
});
```

The hook fires **before** the CLI's atomic staging commit, so artifacts
written to `result.outDir` survive the swap into `dist/`. Do not write
to `join(context.root, "dist")` directly — that path is replaced by the
staging swap.

## What's new in v2.3

- **Build-time compiler integration** — the kit now detects
  [`@elurjs/vite-plugin-elur`](https://www.npmjs.com/package/@elurjs/vite-plugin-elur)
  (>= 1.1.0) at runtime and skips its legacy interpolation transform
  automatically. The plugin's state-machine lexer takes precedence,
  providing compile-time errors, raw-text tag handling, and boolean
  attribute validation that the kit's heuristic transform lacked.
- **`@elurjs/vite-plugin-elur` as optional peer dependency** —
  `npm install @elurjs/vite-plugin-elur` activates the build-time
  compiler (`@elurjs/core-compiler`), HMR with state preservation,
  and partial attribute interpolation via a state-machine lexer.
- **`pluginSupportsPartialInterpolation()`** — new exported function
  detects the Vite plugin at runtime.
- **`shouldUseLegacyInterpolation("auto")`** — now returns `false`
  when the plugin is installed, `true` only when neither the plugin
  nor the core supports partials.

### Using the kit with the Vite plugin (recommended)

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { elurJsKit } from "@elurjs/kit/vite";
import elurJsPlugin from "@elurjs/vite-plugin-elur";

export default defineConfig({
  plugins: [
    elurJsKit(),
    elurJsPlugin(),  // compiler: true by default
  ],
});
```

When both plugins are installed:

| Feature | Kit only | Kit + Vite plugin |
| --- | --- | --- |
| Partial attr interpolation | Legacy transform (heuristic) | State-machine lexer (compile-time) |
| Build-time compiler | No | Yes (`html\`\`` → imperative DOM) |
| HMR state preservation | No | Yes (signals, stores, forms, routers) |
| Scroll/focus preservation | No | Yes |
| SSR | Works (kit handles it) | Works (plugin skips compiler in SSR) |

The Vite plugin detects SSR via `transformOptions.ssr` (Vite 5–7) or
`this.environment.config.consumer === "server"` (Vite 8) and skips
the compiler and HMR transforms for SSR modules. Client modules
receive the full transform pipeline.

## What's new in v2.2

- **Native partial attribute interpolation** — when the installed
  Elur core exposes `templateFeatures.partialAttributeInterpolation`
  (core >= 3.3), the kit no longer injects the legacy
  `elurJsInterpolationPlugin` transform (`interpolation: "auto"`, the
  default). Partial attributes run through the runtime's native
  normalization, preserving fine-grained reactivity.
  - New `interpolation: "auto" | "legacy" | "off"` option on
    `elurJsKit()`, `buildClientBundle()` and `transformProjectFiles()`.
  - `interpolation: "legacy"` forces the old transform for migrations
    (deprecated, one-time warning); `interpolation: "off"` disables it.
  - `transformPartialInterpolations` stays exported for direct
    consumers and is marked deprecated.
- **`coreSupportsPartialInterpolation()`** and
  **`shouldUseLegacyInterpolation()`** exported from
  `@elurjs/kit/vite` for programmatic resolution.

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
  *(Note: fully removed in v2.4 — the core's DOM-free `renderToString`
  made the fallback unnecessary.)*

## What's new in v2.0

- **Breaking: Node >=20.19.0** — dropped Node 18 support. Vite 7/8 and the core engine require Node 20.19+.
- **Breaking: Core v3** — `@elurjs/core` peer dependency upgraded to `^3.0.0`. New subpaths `@elurjs/core/server` and `@elurjs/core/hydrate` for SSR without DOM simulation and real hydration over existing DOM.
- **Breaking: Image pipeline** — `image()` now emits `<picture>` from a content-addressed manifest. No more broken `srcset` URLs. Sharp is optional.
- **Breaking: Config** — `defineConfig()` from `@elurjs/kit/config`. No `__dirname` in ESM configs.
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
- **DX: Scaffold** — `create-elur-app` with `template-kit` option.
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

- **Automatic attribute interpolation** — no more manual workarounds for `href="/blog/${slug}"`. When the installed Elur core supports partial attribute interpolation natively (`templateFeatures.partialAttributeInterpolation`, core ≥ 3.3), the kit skips its legacy transform and lets the runtime handle the syntax — with reactivity preserved. On older cores the legacy rewrite still applies automatically (`interpolation: "auto"`), and `interpolation: "legacy"` forces it for migrations (deprecated; emits a one-time warning).
- **Client router in the bundle** — the SPA router lives in the generated client entry (`/_elur/entry-client.js`) instead of being inlined into every page, keeping the HTML clean and the routing code cacheable.
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
| v2.0.2 | Cumplimiento: keyed hydration, streaming chunks/protocols (core), static Range/HEAD, errores sanitizados, imágenes hardening + `getImage`/`ImageService`, capabilities, islands `lazyIsland`, E2E Playwright (16 tests) ✅ |
| v2.1 | Route-level code-splitting, layout slots, Redis/Cloudflare KV cache adapters, real Suspense streaming, `happy-dom` optional ✅ |
| v2.2 | Native partial attribute interpolation (`interpolation: "auto"/"legacy"/"off"`), `coreSupportsPartialInterpolation()` / `shouldUseLegacyInterpolation()` exported ✅ |
| v2.3 | Build-time compiler integration via `@elurjs/vite-plugin-elur` (optional peer), `pluginSupportsPartialInterpolation()`, legacy interpolation delegates to plugin ✅ |
| v2.4 | CLI image registry singleton fix, `happy-dom` fully removed, `raw()` SSR support, config renamed to `elur.config.*` ✅ |
| v2.4.2 | Integration `build` hook wired into `build()`, `BuildResult.outDir` for post-build artifacts ✅ |
| v2.4.3 | Client-only islands (`directive: "only"`, `options: { ssr: false, fallback }`), `isSSR()` export, SSR error wrapping ✅ |
| v2.4.4 | Fix: `"only"` directive now hydrates immediately like `"load"`. Fix: islands without SSR DOM use fresh `_render` mount instead of `hydrateTemplate` ✅ |

## API

### `renderToString(factory)`

Renders a Elur template to an HTML string in Node.js.

```ts
import { renderToString } from "@elurjs/kit";
import HomePage from "./src/app/page";

const body = await renderToString(() => HomePage({ data: { title: "Hi" } }));
```

### `documentShell(options)`

Wraps rendered HTML in a full document shell with `<script id="elur-data">`.

```ts
import { documentShell } from "@elurjs/kit";

const html = documentShell({
  title: "My Page",
  body,
  data: { title: "My Page" },
  clientEntry: "/_elur/entry-client.js",
});
```

### Islands

Create an interactive component in `src/islands/`:

```ts
// src/islands/LikeButton.ts
import { html, signal } from "@elurjs/core";

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
import { html, island } from "@elurjs/kit";
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
import { hydrateIslands } from "@elurjs/kit/island";
import LikeButton from "./islands/LikeButton";

hydrateIslands({ LikeButton });
```

Lazy (code-split) islands use a discriminated `{ load }` loader so the hydrator
can tell eager components from lazy loaders **without invoking them** (no probe
side effects):

```ts
import { lazyIsland, hydrateIslands } from "@elurjs/kit/island";

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

| Directive | Hydration trigger | SSR? |
| --- | --- | --- |
| `load` | Immediately | Yes (component runs on server) |
| `idle` | `requestIdleCallback` | Yes (component runs on server) |
| `visible` | `IntersectionObserver` | Yes (component runs on server) |
| `only` | Immediately | **No** — client-only, component never runs on server |

#### Client-only islands (`directive: "only"` / `ssr: false`)

Components that access browser-only globals (`document`, `window`,
`navigator`, `localStorage`, ...) in their body — carousels, charts,
third-party widgets — cannot run on the server. Use `directive: "only"`
(shortcut, hydrates on `load`) or `options: { ssr: false }` (combines
with any directive) to skip SSR entirely:

```ts
import { html, island } from "@elurjs/kit";

// Client-only, hydrates on load, empty fallback
island("Carousel", Carousel, { slides: [...] }, "only")

// Client-only + fallback HTML (string or ElurTemplate)
island("Carousel", Carousel, { slides: [...] }, "only", {
  fallback: "<div class=\"skeleton\" />",
})

// Client-only + hydrate when visible (more flexible than "only")
island("Chart", Chart, { data }, "visible", { ssr: false })
```

When SSR is skipped, only `options.fallback` is rendered inside the
island marker. The client hydrates from scratch.

#### `fallback` option

`options.fallback` accepts a plain string or a `ElurTemplate` (reactive,
with signals). It is rendered when:

- SSR is skipped (`"only"` or `ssr: false`), or
- The component returns `null` / `false` / `undefined` during SSR.

```ts
island("Widget", Widget, { id: 1 }, "load", {
  fallback: html`<p class="placeholder">Loading…</p>`,
})
```

#### `isSSR()` — environment reads

For components that only need *environment* reads (`window.matchMedia`,
`localStorage`, `navigator.userAgent`), guard the access with `isSSR()`
instead of skipping SSR entirely — this preserves the SSR fallback HTML:

```ts
import { html, signal } from "@elurjs/core";
import { isSSR } from "@elurjs/kit";

function ThemeToggle() {
  const prefersDark = isSSR() ? false : window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = signal(prefersDark);
  return html`<button @click=${() => (dark.value = !dark.value)}>${() => (dark.value ? "🌙" : "☀")}</button>`;
}

island("ThemeToggle", ThemeToggle, {}, "load")  // SSR works, no "only" needed
```

:::warning Limitation
`isSSR()` is **not** a replacement for `"only"` / `ssr: false`. It only
works for environment reads. `document.querySelectorAll(".slide")` of
the component's own children will **not** work with `isSSR()` because
the DOM is not inserted when the function body runs (neither on the
server nor during hydration). For DOM queries of own children, use
`ElurComponent.onMount()` + `ref` — `onMount` runs after the DOM is
inserted, the equivalent of React's `useEffect`.
:::

#### SSR errors are not silenced

If an island component throws during SSR (with a directive other than
`"only"` and `ssr` not set to `false`), the error propagates wrapped
with the island name and remediation hints — it is never silently
swallowed. This matches Astro and Next.js, which never `try/catch` to
"auto-detect" client-only components:

```
[elur-kit] Island "Carousel" threw during SSR: document is not defined
  If the component accesses browser-only globals (document, window, etc.),
  use directive: "only" or options: { ssr: false } to skip server rendering.
  For environment reads (matchMedia, localStorage, navigator) you may guard
  the access with isSSR() from "@elurjs/kit".
```

### `build(config)`

Scans `src/app/` and generates the full static site in `dist/`. You can call it
from code or use the `elur-kit build` CLI (see [CLI](#cli)).

```ts
import { build } from "@elurjs/kit";

await build({
  appDir: "./src/app",
  outDir: "./dist",
  clientEntry: "/_elur/entry-client.js",
  // Optional: auto-generate the hydration entry from src/islands/
  islandsDir: "./src/islands",
  generatedEntry: "./.elur/entry-client.ts",
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
import { html } from "@elurjs/core";
import type { PageProps, GenerateStaticParams } from "@elurjs/kit";
import { load } from "./page.data.ts";

export const generateStaticParams: GenerateStaticParams = async () => {
  return [{ slug: "hello-world" }, { slug: "elur-kit" }];
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
import type { PageDataLoad } from "@elurjs/kit";

export const load: PageDataLoad = async ({ params }) => {
  return { title: `Post: ${params.slug}` };
};
```

Running `elur-kit build` then produces:

```
dist/blog/hello-world/index.html
dist/blog/elur-kit/index.html
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
`elurJsAction()`:

```ts
// src/app/contact/page.action.ts
export async function submitContact(data: { name: string; email: string }) {
  // validate, write to DB, send email, etc.
  return { ok: true };
}
```

```ts
// src/app/contact/page.ts or any island
import { elurJsAction } from "@elurjs/kit/action";

const contact = elurJsAction("submitContact", { page: "/contact" });

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

`elurJsAction` returns a reactive handle with:

- `submit(input)` — calls the action and updates the signals.
- `pending` — signal that is `true` while the action is running.
- `error` — signal with the last error, or `null`.
- `data` — signal with the last successful result, or `null`.

The `page` option scopes the action to a specific route, avoiding name
collisions between different `page.action.ts` files. If you omit it, the
framework falls back to searching all scanned actions by name.

For lower-level control, use `callAction` directly:

```ts
import { callAction } from "@elurjs/kit/action";

const result = await callAction("submitContact", { name: "Ada", email: "ada@example.com" }, { page: "/contact" });
```

#### Progressive enhancement

Actions also work without JavaScript. Add hidden fields to a plain HTML form
and POST to `/__elur/actions`:

```html
<form action="/__elur/actions" method="POST">
  <input type="hidden" name="__elur_js_action_name" value="submitContact" />
  <input type="hidden" name="__elur_js_action_page" value="/contact" />
  <input name="name" />
  <input name="email" />
  <button type="submit">Send</button>
</form>
```

The server runs the action and redirects back to the referring page (or to the
string returned by the action). If the client sends `Accept: application/json`,
the result is returned as JSON instead.

The framework exposes the `POST /__elur/actions` endpoint in every server mode
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
import { html } from "@elurjs/core";

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
import { html } from "@elurjs/core";

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

- During `elur-kit build` as `dist/404.html` and `dist/500.html`.
- During `elur-kit start` and in the Vite plugin for unmatched routes and render errors.
- In every deployment adapter (`vercel`, `netlify`, `bun`, `node`) for unmatched routes and SSR render failures.

Error pages receive the same `PageProps` as regular pages and can export their own `404.page.data.ts` or `500.page.data.ts` loaders.

### SSR runtime

`elur-kit start` runs a Node HTTP server that renders pages on demand,
matching the request URL against the scanned routes and running loaders with
params and search params. Static files are served from the output directory
first, so the client bundle and other assets keep working:

```bash
elur-kit build          # build the client bundle and any static files
elur-kit start          # SSR server on http://127.0.0.1:3000
```

You can also use the lower-level API to embed the SSR server in a custom Node
app:

```ts
import { createSsrServer } from "@elurjs/kit";

const ssr = await createSsrServer({
  appDir: "./src/app",
  publicDir: "./dist",
  clientEntry: "/_elur/entry-client.js",
  port: 3000,
});
await ssr.listen();
```

### Vite plugin

The official Vite plugin gives you a Vite-native dev server with SSR rendering
and automatic island entry generation:

```ts
import { defineConfig } from "vite";
import { elurJsKit } from "@elurjs/kit/vite";

export default defineConfig({
  plugins: [elurJsKit()],
});
```

Then run the Vite dev server:

```bash
npx vite
```

The plugin scans `src/app/`, writes `.elur/entry-client.ts` and renders every
page on demand. For production, keep using `elur-kit build` to generate static
HTML and the client bundle.

#### Using with the build-time compiler (recommended)

For the best performance, install
[`@elurjs/vite-plugin-elur`](https://www.npmjs.com/package/@elurjs/vite-plugin-elur)
and add it to your Vite config alongside the kit plugin:

```ts
import { defineConfig } from "vite";
import { elurJsKit } from "@elurjs/kit/vite";
import elurJsPlugin from "@elurjs/vite-plugin-elur";

export default defineConfig({
  plugins: [
    elurJsKit(),
    elurJsPlugin(),  // compiler: true by default
  ],
});
```

The Vite plugin activates:

- **Build-time compiler** — lowers `html\`\`` templates to imperative DOM
  code (`firstChild`/`nextSibling` navigation, inline `setAttribute`,
  grouped effects, event delegation). Eliminates `detectContext`,
  `buildHTML`, and both `TreeWalker` passes in runtime.
- **Partial attribute interpolation** — state-machine lexer rewrites
  `class="btn ${size}"` to `class=${__elurCompose("btn ", size)}` at
  build time. Takes precedence over the kit's legacy transform.
- **HMR with state preservation** — signals, stores, forms, and
  routers declared at module scope survive hot updates.
- **Scroll/focus preservation** — scroll position and focused element
  are restored after re-mount.

The plugin is SSR-safe: it detects SSR via `transformOptions.ssr`
(Vite 5–7) or `this.environment.config.consumer === "server"` (Vite 8)
and skips the compiler and HMR transforms for SSR modules. Client
modules receive the full transform pipeline.

To disable the compiler (keep HMR and interpolation):

```ts
elurJsPlugin({ compiler: false })
```

#### Partial attribute interpolation

Partial interpolations inside attribute values (`href="/blog/${slug}"`)
are handled in three ways, in priority order:

1. **Vite plugin** (recommended) — when
   `@elurjs/vite-plugin-elur` >= 1.1.0 is installed, its
   state-machine lexer rewrites partial interpolations at build time
   with compile-time error detection, raw-text tag handling, and
   boolean attribute validation. The kit detects the plugin via
   `pluginSupportsPartialInterpolation()` and skips its own transform.
2. **Core native** — when the Elur core exposes
   `templateFeatures.partialAttributeInterpolation` (core >= 3.3),
   the runtime normalizes partial attributes natively.
3. **Kit legacy transform** — fallback for projects without the
   plugin and with older cores. Heuristic HTML tag walker, less
   powerful than the plugin's lexer.

Control the behavior with the `interpolation` option on `elurJsKit()`:

```ts
elurJsKit({ interpolation: "auto" })   // default — plugin > core > legacy
elurJsKit({ interpolation: "legacy" }) // force legacy transform (deprecated)
elurJsKit({ interpolation: "off" })    // never transform
```

The same option is available on `buildClientBundle()` and
`transformProjectFiles()`.

### Adapters

Deploy to Vercel with the built-in adapter. First build the site, then generate
the Vercel output:

```bash
elur-kit build
elur-kit adapter vercel
```

This produces a `.vercel/output` directory that includes:

- `static/` — the static files from `dist/`.
- `functions/__elur-kit.func/index.js` — a bundled SSR function for unmatched routes.
- `config.json` — Vercel Build Output API v3 routing config.

You can also use the adapter programmatically:

```ts
import { vercelAdapter } from "@elurjs/kit/adapters/vercel";

await vercelAdapter.build({
  root: process.cwd(),
  appDir: "src/app",
  islandsDir: "src/islands",
  outDir: "dist",
  clientEntry: "/_elur/entry-client.js",
  lang: "es",
});
```

### Netlify adapter

Deploy to Netlify with the built-in adapter:

```bash
elur-kit build
elur-kit adapter netlify
```

This produces:

- `netlify/functions/__elur-kit.mjs` — bundled SSR function for Netlify Functions v2.
- `netlify.toml` — redirects unmatched routes to the function.

The static files stay in `dist/` and are served directly by Netlify. Programmatic usage:

```ts
import { netlifyAdapter } from "@elurjs/kit/adapters/netlify";

await netlifyAdapter.build({
  root: process.cwd(),
  appDir: "src/app",
  islandsDir: "src/islands",
  outDir: "dist",
  clientEntry: "/_elur/entry-client.js",
  lang: "es",
});
```

### Bun adapter

Run a production server with Bun:

```bash
elur-kit build
elur-kit adapter bun
bun run .elur/bun-server.ts
```

This generates:

- `.elur/bun-index.ts` — SSR handler entry.
- `.elur/bun-server.ts` — Bun server that serves `dist/` static files and renders pages on demand.

The server respects the `PORT` environment variable (default `3000`). Programmatic usage:

```ts
import { bunAdapter } from "@elurjs/kit/adapters/bun";

await bunAdapter.build({
  root: process.cwd(),
  appDir: "src/app",
  islandsDir: "src/islands",
  outDir: "dist",
  clientEntry: "/_elur/entry-client.js",
  lang: "es",
});
```

### Node adapter

Run a production server with Node (>=20.19.0):

```bash
elur-kit build
elur-kit adapter node
node .elur/node-server.mjs
```

This generates a single bundled `.elur/node-server.mjs` that serves `dist/` static files and renders pages on demand. The server respects the `PORT` environment variable (default `3000`). Programmatic usage:

```ts
import { nodeAdapter } from "@elurjs/kit/adapters/node";

await nodeAdapter.build({
  root: process.cwd(),
  appDir: "src/app",
  islandsDir: "src/islands",
  outDir: "dist",
  clientEntry: "/_elur/entry-client.js",
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
  clientEntry: "/_elur/entry-client.js",
  islandsDir: "./src/islands",
  generatedEntry: "./.elur/entry-client.ts",
});
```

Given `src/islands/LikeButton.ts` and `src/islands/nav/MobileMenu.ts`, the
generated `.elur/entry-client.ts` looks like:

```ts
// AUTO-GENERATED by @elurjs/kit. Do not edit.
import { hydrateIslands } from "@elurjs/kit/island";
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
import { scanIslands, generateClientEntry } from "@elurjs/kit";

const islands = await scanIslands("./src/islands");
await generateClientEntry({ islands, outFile: "./.elur/entry-client.ts" });
```

### Metadata API

Pages can export a `generateMetadata` function or return a `metadata` field
from loaders. The framework generates `<title>`, `<meta>`, `<link>`, OpenGraph
and Twitter card tags, all marked with `data-elur-head` so the SPA router
can swap them on navigation.

```ts
// src/app/blog/[slug]/page.ts
import type { PageMetadata } from "@elurjs/kit";

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
import { defineCollection } from "@elurjs/kit/content";

export const collections = {
  blog: defineCollection({ /* schema: z.object({ title: z.string() }) */ }),
};
```

```ts
// src/app/blog/[slug]/page.data.ts
import { getEntry } from "@elurjs/kit/content";

export const load = async ({ params }) => {
  const post = await getEntry("blog", params.slug);
  if (!post) throw new Response("Not Found", { status: 404 });
  return { post };
};
```

```ts
// src/app/blog/[slug]/page.ts
import { raw } from "@elurjs/kit/content";
import { renderEntryHTML } from "@elurjs/kit/content";

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
import { image } from "@elurjs/kit";

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
import { getImage, createImageService } from "@elurjs/kit/image";

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
  `@elurjs/kit/runtime`.
- `validateCapabilities(caps, { isr, images, streaming })` is checked by the
  CLI `adapter` command so incompatible host+feature combinations fail at build.

### Middleware

Create `src/middleware.ts` to run logic before every request (auth, redirects,
header injection):

```ts
import type { Middleware } from "@elurjs/kit";

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
├── elur.config.ts
└── vite.config.ts
```

## License

MIT © Deiver Vasquez
