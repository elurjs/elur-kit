# Changelog

All notable changes to Nix.js Kit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.4.6]

### Fixed

- **`isSSR()` always returned `false`** — the kit's `ssr-flag.ts` used
  `Symbol.for("@elurjs/core/reactivity-state")` while `@elurjs/core` < 3.5.1
  used `Symbol.for("elur/reactivity-state")`. The mismatched symbols meant
  the kit's `setSSR(true)` during `renderToString` never wrote to the core's
  reactivity state, so `isSSR()` read `undefined` and defaulted to `false`.
  Fixed in `@elurjs/core@3.5.1` which now namespaces its internal symbols
  under `@elurjs/core/*`. Peer dependency bumped to `^3.5.1`.

### Changed

- **`happy-dom` re-added as a test-only `devDependency`** — it was fully
  removed in v2.4, but 5 client-side test suites (`island.test.ts`,
  `island-reactive-array.test.ts`, `island-client-only.test.ts`,
  `client-router.test.ts`, `client-router-a11y.test.ts`) still imported it
  and failed with `ERR_MODULE_NOT_FOUND`. It is now back **only** in
  `devDependencies` to provide a DOM environment for those tests. It is
  never imported by `src/`, never referenced by either vite build config,
  and never shipped in the published bundle (`files` contains only
  `dist/lib`). `test/happy-dom-optional.test.ts` guards this invariant.

## [2.4.4]

### Fixed

- **`island()` directive `"only"` never hydrated on the client** — v2.4.3
  added `"only"` to the SSR side (skip rendering) but the client hydrator
  (`hydrateIslands`) only had branches for `"load"`, `"idle"`, and
  `"visible"`. Markers with `data-directive="only"` were silently skipped
  — the component never mounted, leaving the fallback HTML (or empty
  marker) permanently. Now `"only"` hydrates immediately like `"load"`.
- **`hydrateTemplate` did nothing for islands without SSR DOM** —
  `hydrateTemplate` from the core walks existing DOM for hydration
  markers (`<!--nix-N-->`, `data-nix-e-*`). Islands with `"only"` or
  `ssr: false` have no SSR DOM in the marker (only fallback HTML or
  nothing), so `hydrateTemplate` either silently did nothing (templates
  with no bindings) or threw a mismatch and remounted (templates with
  bindings). The hydrator now detects the absence of `<!--nix-` markers
  and does a fresh `_render` mount instead of `hydrateTemplate`, which
  is the correct operation when there's no SSR DOM to hydrate against.
  This also fixes the same issue for `ssr: false` with any directive.

## [2.4.3]

### Fixed

- **`island()` crashed for client-only components after happy-dom removal**
  — since v2.4.0 removed the happy-dom SSR fallback, `island()` always
  executed the component during SSR. Any island accessing browser-only
  globals (`document`, `window`, `navigator`, ...) in its body crashed with
  `ReferenceError: document is not defined`, breaking carousels, charts, and
  any third-party widget that touches the DOM. The kit now provides two
  opt-out mechanisms mirroring the industry standard (Astro `client:only`,
  Next.js `dynamic(..., { ssr: false })`):
  - `directive: "only"` — shortcut for client-only with `load` scheduling.
    The component is never called during SSR; only the fallback is rendered.
  - `options: { ssr: false }` — client-only with any directive
    (`load`/`idle`/`visible`), combinable with `options.fallback`.
  SSR errors are never silently swallowed: they propagate wrapped with the
  island name and three concrete remediation paths (`"only"`, `{ ssr: false }`,
  `isSSR()`), matching Astro and Next.js behavior.

### Added

- **`IslandOptions`** — new optional 5th parameter to `island()` with:
  - `ssr?: boolean` (default `true`, forced `false` when `directive: "only"`)
  - `fallback?: NixTemplate | string` — HTML rendered inside the island
    marker when SSR is skipped or the component returns `null`/`false`.
    Accepts a reactive `NixTemplate` (with signals) or a plain string.
- **`island()` `fallback` for null components** — when an SSR-safe component
  returns `null`/`false`/`undefined`, the `fallback` option is now rendered
  instead of an empty marker.
- **`isSSR()` exported from the main entry** — reads the Nix.js reactivity
  SSR flag. Use it to guard environment reads (`window.matchMedia`,
  `localStorage`, `navigator`) in SSR-safe components. Note: `isSSR()` is
  NOT a replacement for `"only"`/`ssr: false` — it cannot make
  `document.querySelectorAll` of the component's own children work, because
  the DOM is not inserted when the function body runs. For DOM queries of
  own children, use `NixComponent.onMount()` + `ref`.
- **`IslandDirective` now includes `"only"`** — the type union is
  `"load" | "idle" | "visible" | "only"`. The duplicate type definition in
  `hydrate.ts` was replaced with a re-export from `island.ts` for a single
  source of truth.

## [2.4.2]

### Fixed

- **`BuildResult.outDir`** — added `outDir` field to `BuildResult` so
  integration `build` hooks know the actual output directory (the atomic
  staging temp dir when called via the CLI, not the final `dist/`).
  Without this, integrations that wrote to `join(context.root, "dist")`
  had their artifacts wiped by the atomic staging commit. Now integrations
  can use `result.outDir` to write to the correct directory.

## [2.4.1]

### Fixed

- **Integration `build` hook never invoked** — the `build` hook was
  declared in `NixKitIntegration` but never called from `build()`.
  `runIntegrationHook` was only wired for `"config"` (from
  `config/index.ts`) and `"routes"` (from `manifest/index.ts`). Now
  `build()` invokes `runIntegrationHook(integrations, "build", [result,
  ctx])` at the end of the build pipeline, after all pages, image
  variants, and the manifest are written. This lets integrations
  generate post-build artifacts (sitemaps, robots.txt, search indexes)
  into the output directory. The hook fires before the CLI's atomic
  staging commit, so integration artifacts survive the swap.
- **`BuildConfig.integrations`** — new optional field. The CLI's
  `toBuildConfig()` now passes `resolvedConfig.integrations` through.

## [2.4.0]

### Fixed

- **CLI bundling bug — image registry dual instance** — the CLI bundle
  (`dist/lib/cli.js`) was inlining its own copy of the image registry
  (`renderRegistry`, `activeManifest`), separate from the chunk
  `dist/lib/image/index.js` that user pages import. This caused
  `consumeImageRegistry()` to always return `[]`, so the two-pass image
  pipeline silently processed nothing (no manifest, no variants, no
  `<picture>`). Fixed by extracting the registry state to a dedicated
  chunk `src/image/registry.ts` and externalizing it in
  `vite.cli.config.ts` via a custom plugin, so the CLI imports the same
  physical `./image/registry.js` chunk that `image/index.js` uses.
- **`raw()` missing `renderServer`** — after removing the happy-dom
  fallback, the core's DOM-free `renderToString` requires templates to
  expose `NIX_RENDER_PROTOCOL.renderServer`. `raw()` only had `mount`
  and `_render` (DOM-dependent), causing "Template does not support
  server rendering" errors. Fixed by adding `renderServer: () => html`
  to `raw()`, matching the pattern already used by `image()` and
  `island()`.
- **Streaming response test mocks** — updated mock templates in
  `test/streaming-response.test.ts` to use `renderServer` instead of
  DOM-dependent `_render`, and removed an invalid `supportsStreaming({})`
  call that didn't match the `Pick<AdapterCapabilities, "streaming">`
  parameter type.

### Changed

- **`happy-dom` fully removed** — the kit no longer references happy-dom
  anywhere. The SSR runtime uses the core's DOM-free `renderToString`
  (`@deijose/nix-js/server`) directly, with no DOM fallback. Removed
  from `peerDependenciesMeta`, from both vite build configs
  (`external`/`globals`), and from `src/render/render-to-string.ts`
  (the `renderWithDom` fallback and `MANAGED_GLOBALS` injection were
  deleted). The `test/happy-dom-optional.test.ts` now asserts happy-dom
  is absent from all dependency fields.
- **Config file renamed: `nix.config.*` → `nix-js.config.*`** — the
  generic `nix.config.ts` name was a design error that could collide
  with other tools. The kit now looks for `nix-js.config.{ts,js,mjs}`
  first. Legacy `nix.config.*` files are still detected for backward
  compatibility, but emit a deprecation warning guiding migration.
  `doDoctor` reports legacy config files as `warn` status.

### Added

- **`src/image/registry.ts`** — new shared singleton module owning the
  image pipeline's mutable state (`renderRegistry`, `activeManifest`).
  Exported as `dist/lib/image/registry.js` and added to
  `tsconfig.lib.json` and `vite.lib.config.ts` entry points. Both the
  CLI bundle and the library chunk import this physical file, ensuring
  a single module instance across the build pipeline.

## [2.3.0]

### Changed

- **Interpolation now delegates to the Vite plugin** — when
  `@deijose/vite-plugin-nix-js` >= 1.1.0 is installed, the kit's legacy
  interpolation transform is skipped (the plugin's state-machine lexer takes
  precedence). The kit's transform remains as a fallback for projects that
  use the kit without the plugin.
- New `pluginSupportsPartialInterpolation()` function detects the Vite plugin
  at runtime.
- `shouldUseLegacyInterpolation("auto")` now returns `false` when the plugin
  is installed, `true` when neither the plugin nor the core supports partials.
- `@deijose/vite-plugin-nix-js` added as an optional peer dependency.

### Migration

- Install `@deijose/vite-plugin-nix-js` >= 1.1.0 for the best interpolation
  support (state-machine lexer, compile-time errors, raw-text tag handling).
- The kit's legacy transform still works without the plugin but is less
  powerful (no comment/raw-text handling, no boolean attr validation).

## [2.2.1]

### Changed

- `coreSupportsPartialInterpolation()` and `shouldUseLegacyInterpolation()`
  are now exported from `@deijose/nix-js-kit/vite` so consumers can resolve
  the interpolation mode programmatically.

## [2.2.0]

### Changed

- **Native partial attribute interpolation** — when the installed Nix.js core
  exposes `templateFeatures.partialAttributeInterpolation` (core ≥ 3.3), the
  kit no longer injects the legacy `nixJsInterpolationPlugin` transform
  (`interpolation: "auto"`). Partial attributes now run through the runtime's
  native normalization, which preserves fine-grained reactivity instead of
  collapsing getters into a static concatenation.
  - New `interpolation: "auto" | "legacy" | "off"` option on `nixJsKit()`,
    `buildClientBundle()` and `transformProjectFiles()`.
  - `interpolation: "legacy"` forces the old transform for migrations and
    emits a one-time deprecation warning; `interpolation: "off"` disables it.
  - `transformPartialInterpolations` stays exported for direct consumers and
    is marked deprecated.

## [2.1.0]

### Added — five reported limitations fixed

- **#1: Route-level code-splitting** — the generated client entry already uses
  `import()` per island, producing separate chunks per page for a minimal
  initial bundle. Documented and verified with tests.
- **#2: Layout Slots** — `*.slot.ts` files are now detected by the route
  scanner and passed to layout components as named slots (`slots.sidebar`,
  `slots.header`, etc.). Route groups (`(group)`) already worked; this adds
  named slot composition on top.
- **#3: Redis / Upstash / Cloudflare KV cache adapters** — new
  `createRedisCacheAdapter()` and `createCloudflareKVCacheAdapter()` in
  `@deijose/nix-js-kit/cache`, implementing the same `CacheAdapter` interface
  as the filesystem adapter. Tag-based invalidation works via Redis sets or
  KV JSON indexes.
- **#4: Real Suspense streaming** — `streamBoundary()` and
  `createStreamingResponse()` now emit a `<template>` chunk + replacement
  script that swaps the fallback `<div>` for the resolved content in-place
  (using `replaceWith`), instead of the old `innerHTML` append pattern.
  New helpers: `buildFallbackHtml()`, `buildResolvedChunk()`.

### Changed

- **#5: `happy-dom` moved to optional peer dependency** — removed from
  `dependencies`, added to `peerDependenciesMeta` with `optional: true`.
  The SSR runtime loads it via dynamic `import("happy-dom")` only when the
  core renderer needs a DOM fallback; it is never bundled into client code.

## [2.0.4]

### Added — recursive content collections

- `getCollection()` now scans nested directories and derives nested slugs
  (e.g. `getting-started/intro`), removing the need for manual content scanners.

## [2.0.3]

### Added — island HMR (Vite plugin)

- The generated client entry now registers `import.meta.hot.accept` so island
  module changes are **hot-swapped without a full page reload**: current islands
  are disposed and re-hydrated from the updated modules (audit §10.2 / §12.2).
- New E2E in `example/e2e/hmr.spec.ts` (Playwright + Vite plugin dev server)
  verifies the DOM updates with `performance navigation` count unchanged.
- Script: `npm run test:e2e:hmr`.

## [2.0.2]

### Fixed — compliance and correctness (audit §8–§10)

- **Unified CLI request pipeline** — `handleRequest` (dev/preview) now delegates
  to `createWebHandler`, the same code used by the Node/Bun/Vercel/Netlify
  adapters. The duplicated actions/render-endpoint/API/static/SSR/404/500
  pipeline in `src/cli.ts` was removed (audit §8.1, Risk 1).
- **`start` with missing middleware (Bun)** — `loadMiddleware` matched
  "module not found" via `err instanceof Error`, but Bun's `ResolveMessage` is
  not an `Error` instance, so projects without `src/middleware.ts` failed to
  start. Detection now uses the message property directly.
- **Stale content after server actions under SSR** — the `start` server and the
  unified handler rewrite the baked `nix-js:render-endpoint content="off"` meta
  to `"on"` when serving static HTML, so SPA navigations after a mutating
  action fetch live server-rendered content instead of the stale static file
  (fixes e.g. "review published without reload").
- **Stale core bundled in the CLI** — `vite.cli.config.ts` externalizes
  `@deijose/nix-js/*` (including subpaths) so the CLI never bundles an
  outdated copy of the core server renderer.
- **Island loader detection without probing** — the registry now uses a
  discriminated `{ load }` lazy form plus `AsyncFunction` detection (never
  invoking the component as a probe, avoiding side effects / duplicate signal
  creation). New `lazyIsland()` helper (audit §10.3).
- **Production error sanitization** — new `toPublicErrorInfo()` /
  `publicErrorResponse()` in `src/errors.ts`; the unified handler, action
  server and adapters no longer expose `String(err)` (paths/stacks/secrets) in
  responses (audit §8.4, Risk 5).

### Added — static serving, images and capabilities

- **Static serving Range/If-Range/HEAD** — `serveStaticFile` now supports
  `Accept-Ranges`, single `Range` with `If-Range` (ETag or date), `206` with
  `Content-Range`, `416` for unsatisfiable ranges, and uniform HEAD responses
  (audit §8.3).
- **Image pipeline hardening** — SHA-256 transform keys (content + normalized
  options + encoder/naming versions), path containment for sources and outputs
  (no traversal/NUL/symlink escape), atomic temp+rename writes, single-flight
  per transform key, bounded concurrency pool, and `images.strict` build mode
  (audit §9.4–§9.7).
- **`getImage()` and `ImageService`** — programmatic async image API and the
  `ImageService`/`createImageService` contract with declared capabilities
  (audit §9.2–§9.3).
- **Adapter capability contract** — `AdapterCapabilities` (streaming,
  filesystem none/readonly/persistent/ephemeral, imageRuntime, backgroundWork,
  maxBodySize), defaults for full/serverless/edge hosts, and build-time
  `validateCapabilities()` diagnostics in the CLI `adapter` command
  (audit §8.5).

### Test

- New suites: static range/HEAD (10), error sanitization (6), image hardening
  (12), capabilities (10), cross-runtime parity (3), island lazy-loader
  detection (3). Full suite at 442 tests (was 398). Fixed pre-existing failing
  tests: island entry generator (`require` in ESM), benchmark variance
  threshold, and the router clear-cookie test (happy-dom does not honor
  `Max-Age=0` removal).

### Docs

- README: streaming labelled experimental; static serving now documents
  Range/HEAD. See `docs/nix-js-kit/` for the full remediation record.

## [2.1.x] — v2 development

### Fixed — v2.0.1 patch: hydration and asset serving

- **SSR hydration markers** — `renderToString` in `src/render/render-to-string.ts` now passes `markers: "hydration"` to the core `renderServer` by default. Previously it omitted the option, so the SSR output had no `<!--nix-N-->` comments or `data-nix-e-*`/`data-nix-a-*` attributes, causing `[nix-js] Hydration marker mismatch: Template has no hydration descriptor` on every island.
- **Island async loader detection** — `src/island/hydrate.ts` detected lazy loaders via `entry.constructor?.name === "AsyncFunction"`, but `() => import(...).then(m => m.default)` is a regular function returning a Promise, not an `AsyncFunction`. This caused `e._render is not a function` because the loader function was passed directly to `hydrateTemplate` instead of being awaited. Fixed by probing the entry and checking `result instanceof Promise`.
- **Client bundle base path** — `buildClientBundle` in `src/cli.ts` used `base: "/"` by default, so Vite's modulepreload helper generated URLs like `/assets/ThemeToggle.js` instead of `/_nix-js/assets/ThemeToggle.js`, causing 404s for all island chunks. Fixed by hardcoding `base: "/_nix-js/"` for the client bundle (independent of the project's deployment `base`).
- **Test assertions updated** — integration, render, preview, and adapter tests now strip `<!--nix-N-->` / `<!--nix-end-N-->` hydration markers before content assertions, since SSR output now includes them by default.

### Added — Phase 13: Verification, packaging, audit, benchmarks

- **Package smoke test** — `test/package-smoke.test.ts` validates tarball creation, ESM/CJS entry imports, CLI binary, exports map, Node engine, and tarball contents (no src/test/scripts leaked).
- **Path traversal fuzz tests** — `test/path-traversal-fuzz.test.ts` (20 tests) covers encoded traversal (`%2e%2e`, `%2f`, `%5c`), mixed separators, NUL bytes, Unicode normalization (U+FF0E, U+FF0F), prefix-sibling paths, and symlink escape (A-06).
- **CSRF cross-origin tests** — `test/csrf-origin.test.ts` (19 tests) covers same-origin, cross-origin, missing headers, `strictOrigin` mode, allow-list, invalid headers, non-HTTP protocols, and `Sec-Fetch-Site` (A-07).
- **Cache concurrency + isolation tests** — `test/cache-concurrency.test.ts` (13 tests) covers single-flight deduplication, stale-while-revalidate, private/public isolation (cookies, Authorization, no-store), atomicity, collision resistance, and tag invalidation (A-08).
- **SSR benchmark baseline** — `test/benchmark-ssr.test.ts` measures `renderToString` throughput (126,940 renders/sec on the test machine) with a budget floor of 500 renders/sec for regression detection.
- **RequestContext tests** — `test/request-context.test.ts` (17 tests) verifies per-request state: `params`, `locals` isolation, `cookies` (read/write), `signal`, `requestId` uniqueness, `platform`, `response` state, and `applyToResponse()` merging.
- **`bun audit`** — zero vulnerabilities after lockfile cleanup (A-24).
- **`publint`** — `All good!` after splitting `types` conditions into `import`/`require` and adding `.d.cts` declaration copies.
- **Pendientes documentados** — `docs/nix-js-kit/pendientes-infraestructura.md` lista los items que requieren infraestructura externa (Playwright E2E, CI matrix, Provenance/SBOM, `arethetypeswrong`, examples, Lighthouse).

### Changed — Phase 13

- **`RequestContext` aligned with runtime-security §4** — added `params`, `locals`, `cookies` (CookieJar), `signal` (AbortSignal), `requestId` (auto-generated UUID), `platform`, `route`, and `response` (ResponseState with mutable headers and ResponseCookieJar). New `applyToResponse()` method merges accumulated headers, Set-Cookie values, and status into the final Response. New types: `CookieJar`, `ResponseCookieJar`, `CookieOptions`, `ResponseState`.
- **`handleApiRoute`** now passes `locals` alongside `params` to API route handlers.
- **`src/runtime/index.ts`** exports the new cookie and response types.
- **`defineAction`** and related types now exported from `src/index.ts` (main entry).

### Added — Phase 10: Actions, middleware, cookies, cache/ISR

- **`defineAction()`** — typed server action definition with input validation (`.parse()`), AbortSignal propagation, idempotency metadata, and concurrency modes (`latest`, `queue`, `parallel`). Legacy action exports preserved.
- **`CacheAdapter`** — filesystem cache with SHA-256 identity keys, atomic temp+rename writes, single-flight per process, stale-while-revalidate (`getWithSWR()`), tag-based invalidation, size limits and periodic cleanup.
- **Cache policy per route** — `CachePolicy` with `public`/`private`/`dynamic` modes, `normalizeCachePolicy()` reads `export const cache` from data modules, `shouldCachePublic()` enforces no public caching for requests with cookies/auth/action-state.
- **Middleware propagation** — `next()` now carries `params` and `locals`, cleanup callbacks executed in `finally`, `loadMiddleware()` distinguishes "file not found" from "file has errors".
- **Cache invalidation hub** — `CacheInvalidator` pub/sub with `connectCacheAdapter()`, `defaultInvalidator` singleton. Actions emit tags/paths; cache listens. No coupling to `nix-query`.

### Added — Phase 11: Streaming, routing, content, SEO, integrations

- **Real streaming** — `createStreamingResponse()` with `ReadableStream` that sends shell + loading fallback, then resolved content chunks with deterministic IDs. `createBufferedResponse()` for adapters without streaming. `streamBoundary` uses `AsyncLocalStorage` per-request.
- **Optional catch-all** — `[[...slug]]` route segments that match the base path and any depth.
- **Route conflict detection** — `scanRoutes()` throws on duplicate path patterns during manifest generation.
- **Safe URL decoding** — `safeDecodeURIComponent()` handles malformed percent-encoding without throwing.
- **Redirects/rewrites/route headers** — `matchRedirect()`, `matchRewrite()`, `matchRouteHeaders()` with `:param` and `*` wildcard support.
- **Sitemap from route manifest** — `generateSitemapFromRoutes()` excludes dynamic/API/error routes, supports `extraUrls` for dynamic routes, splits into sitemap index for >50,000 URLs.
- **Content scope per request** — `withContentRoot()` via `AsyncLocalStorage`, cache key includes root, collection name containment validation (no path traversal).
- **Integration hooks** — typed registry for `I18nIntegration`, `AuthIntegration`, `QueryIntegration`, `TestingIntegration` + custom integrations. Optional packages register without being dependencies.

### Added — Phase 12: DX, scaffold, observability

- **CLI commands** — `check` (typecheck + route/config integrity), `routes` (list all discovered routes), `doctor` (diagnose common issues).
- **Structured logger** — `StructuredLogger` with request ID generation, `Server-Timing` header accumulation, sensitive data redaction (cookies, auth headers), structured JSON output in production.
- **Error messages** — `formatError()` with cause/path/suggestion format, reliable exit codes (`ExitCode`).
- **create-nix-app template** — `template-kit` with config, public, islands, content, tests, adapter-ready scripts.

### Security hardening (Phase 10)

- JSON-LD escapes `<`, `>`, `&`, U+2028, U+2029 to prevent script injection (A-19).
- Action error cookies signed with HMAC SHA-256 (A-20).
- Body limits enforced with stream reading and `413` responses (§8.2).
- Default security headers: `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, CSP with nonce support, HSTS when appropriate, Permissions-Policy.
- Static serving with `ETag`/`If-None-Match`, `Last-Modified`/`If-Modified-Since`, immutable caching for hashed assets.
- `throw new Response()` treated as first-class HTTP control flow from loaders and layout loaders (A-22).
- No public caching of responses with `Set-Cookie`, `private`, or `no-store`.

---

## [1.x] — Release history

## 1.4.8

### Added

- **Full Open Graph image metadata** — `OpenGraphMetadata` now supports `imageAlt`, `imageWidth`, `imageHeight`, and `imageType`, emitted as `og:image:alt`, `og:image:width`, `og:image:height`, and `og:image:type`. `TwitterMetadata` gained `imageAlt` (`twitter:image:alt`). Social scrapers (Twitter/X, LinkedIn, iMessage, WhatsApp) use these tags to render share previews reliably.

## 1.4.7

### Fixed

- **No more 404 storms on static deployments** — static builds now emit `<meta name="nix-js:render-endpoint" content="off">` in the HTML `<head>`, so the client router skips the `/__nix-js/render` endpoint entirely (zero 404 requests). For older builds without the marker, endpoint detection now uses a single shared probe promise — concurrent prefetches generate at most **one** request to the endpoint, and any other failed page falls back to HTML fetching without disabling the endpoint globally.

### Changed

- **Prefetch is now interaction-only by default (Astro-style)** — the router prefetches internal pages on hover/focus instead of prefetching every visible link on load. This removes the post-load burst of page fetches that competed with fonts and images for bandwidth on slow connections. Links can opt back into viewport prefetching with `data-prefetch="viewport"`.

### Added

- **`renderEndpoint` build option** — `BuildConfig.renderEndpoint` (default `true`) controls whether the built HTML announces the render endpoint as available. The SSG `build()` passes `renderEndpoint: false` automatically; dev/preview/SSR servers leave it enabled.

## 1.4.6

### Fixed

- **SPA router now works on static deployments** — when the `/__nix-js/render` endpoint is unavailable (Vercel static, Netlify static, GitHub Pages), the router falls back to fetching the full HTML page and extracting `#app` + `<head>` tags. This enables SPA navigation without a server, matching the dev-mode experience.

## 1.4.5

### Added

- **`headLinks` support in data loaders** — loaders can now return a `headLinks: string[]` array of raw HTML strings (e.g. `<link rel="icon">`, `<link rel="manifest">`, `<meta name="theme-color">`) that are injected directly into `<head>`, alongside the existing `headScripts`. Deduplicated across layout and page data.

## 1.4.4

### Fixed

- **Removed dependency on `_setSSR` from `@deijose/nix-js`** — the published 2.6.0 on npm does not export `_setSSR`/`_isSSR`. The kit now manipulates the reactivity state's `ssr` flag directly via a local `setSSR()` utility in `src/render/ssr-flag.ts`. This fixes the Vercel build error: `SyntaxError: Export named '_setSSR' not found`.

## 1.4.3

### Fixed

- **Pinned `@deijose/nix-js` to 2.6.0** — fixed a build error on Vercel where `^2.5.3` resolved to a newer version that no longer exports `_setSSR`.

## 1.4.2

### Fixed

- **Hash link navigation** — the SPA router now handles `#anchor` links with smooth scroll instead of ignoring them or reloading the page.
- **Scrollable element preservation** — elements marked with `data-scroll-preserve="key"` have their scroll position saved and restored across SPA navigations, preventing sidebar scroll resets.

## 1.4.1

### Fixed

- **JSON-LD in headScripts** — `documentShell` now detects when a `headScript` is already a complete `<script>` tag (e.g. `<script type="application/ld+json">...`) and renders it as-is instead of wrapping it in another `<script>` tag.

## 1.4.0

### Added

- **SEO module** (`@deijose/nix-js-kit/seo`) — sitemap.xml, robots.txt, and JSON-LD structured data generation:
  - `generateSitemap({ siteUrl, urls, outDir })` writes a valid `sitemap.xml` from a list of URL entries (supports `lastmod`, `changefreq`, `priority`).
  - `generateRobots({ siteUrl, outDir, rules?, disallow? })` writes a `robots.txt` with per-user-agent rules and automatic sitemap reference.
  - `jsonLd(schema)` serializes Schema.org structured data into a `<script type="application/ld+json">` tag for rich snippets.
  - Full TypeScript types for all config objects.

## 1.3.1

### Fixed

- **SPA router FOUC fix** — stylesheets (`<link rel="stylesheet">`) and `<style>` tags rendered inside `#app` by layouts are now hoisted to `<head>` on page load and before every SPA navigation, preventing flash-of-unstyled-content on route changes.
- **`headScripts` deduplication** — `collectShellExtras()` now deduplicates `headScripts` from page and layout data, preventing duplicate inline scripts (e.g. anti-flash theme scripts) when both layers emit the same script.

## 1.3.0

### Added

- **CSRF protection for server actions** — `verifyOrigin()` checks the `Origin`/`Referer` header against the `Host` header with optional `allowedOrigins` and `strictOrigin` mode. Configured via `actionSecurity` in the Vite plugin and SSR server options.
- **Action error cookie store** — action failure data is now stored in an ephemeral `__nix_js_action_error` cookie (SameSite=Lax, Max-Age=15s) instead of URL query parameters, improving security and privacy. `props.form` is populated from the cookie and cleared on the next response.
- **Metadata API** — pages can export `generateMetadata(context)` or return a `metadata` field from loaders/layouts. Supports `title`, `description`, `canonical`, `openGraph`, `twitter`, `robots`, and `other` fields. Head tags are marked with `data-nix-js-head` for SPA head merge.
- **Head merge in SPA router** — the client router swaps `<head>` tags marked with `data-nix-js-head` on every navigation, keeping metadata in sync with the current page.
- **Scroll restoration** — the client router saves and restores scroll position per path on `popstate`, so back/forward navigation feels native.
- **Content layer** (`@deijose/nix-js-kit/content`) — typed Markdown collections with YAML frontmatter:
  - `defineCollection({ schema })` for typed frontmatter validation (optional `zod` peer dep).
  - `getCollection(name)`, `getEntry(collection, slug)`, `getEntries(collection, slugs)` for querying content.
  - `renderEntryHTML(entry)` renders Markdown to HTML via `marked` (optional peer dep).
  - Built-in YAML frontmatter parser (strings, numbers, booleans, dates, inline/block arrays) — zero dependencies.
  - `raw(html)` helper for injecting trusted HTML without escaping (e.g. rendered Markdown).
  - HMR for `.md` files in the Vite dev server.
  - `src/content/config.ts` convention for collection definitions.
- **Image optimization** (`@deijose/nix-js-kit/image`):
  - `image()` helper emits responsive `<img>` with `srcset`, `sizes`, `loading="lazy"`, `decoding="async"`, `fetchpriority`, and `width`/`height` to prevent CLS.
  - Build-time pipeline with `sharp` (optional peer dep) generates WebP/AVIF variants at multiple widths with content-based hashing.
  - `processImages()` API for programmatic access; integrated into `build()` via `consumeImageRegistry()`.
  - `BuildConfig.publicDir` and `BuildConfig.imageFormats` options; `BuildResult.imagesProcessed` reports variant count.
- **Link prefetch** — the client router prefetches pages on viewport intersection (IntersectionObserver) and on hover/focus, with a 30s TTL cache. Respects `data-no-prefetch` attribute on individual links.
- **View Transitions API** — the client router uses `document.startViewTransition()` for smooth page transitions when available, with automatic `prefers-reduced-motion` respect.
- **Middleware** — `src/middleware.ts` convention with `config.matcher` for path filtering. Supports `:param` and `:param*` patterns. Return a `Response` to short-circuit (redirect, 401, etc.) or call `next()` to continue. Integrated into SSR server and Vite plugin.
- **Stream boundary** (experimental) — `streamBoundary()` wraps a promise with a loading fallback for out-of-order streaming during SSR.

### Changed

- Action error data moved from URL query params to ephemeral cookies (`__nix_js_action_error`) for security and privacy.
- Head tags use `data-nix-js-head` attribute (was `data-nix-head` internally) for consistent `nix-js` naming.
- `BuildResult` now includes `imagesProcessed` count.
- `SsrServerOptions` includes `actionSecurity` for CSRF configuration.
- `NixJsKitViteOptions` includes `actionSecurity`, `contentDir` for content layer root.
- TypeScript upgraded to 7.0.2 (native Go compiler, 10x faster builds). `baseUrl` removed from `tsconfig.json` (deprecated in TS 7); `paths` now resolve relative to the config file.
- `marked`, `zod`, and `sharp` added as optional peer dependencies via `peerDependenciesMeta`.

## 1.2.7

### Changed

- All identifiers now use the `nix-js` / `nixJs` naming consistently. Public API: `nixAction` is now `nixJsAction` (and the `NixAction` interface is `NixJsAction`). Form protocol fields are now `__nix_js_action_name`, `__nix_js_action_page`, `__nix_js_action_failure`, `__nix_js_action_redirect` and `__nix_js_action_error`; island DOM markers use `__nix_js_island_dispose`. The default document title is `Nix.js Kit App`.

## 1.2.6

### Added

- `fail()` and `redirect()` now accept both argument orders (`fail(400, data)` or `fail(data, 400)`, `redirect(303, "/x")` or `redirect("/x")`) and are detected via marker fields, so they work even when the CLI/adapters are bundled separately from the user's action modules.
- Source transform (`transformProjectFiles`) mirrors the project layout and compensates relative imports that escape the mirrored tree, so apps importing outside `src/` (e.g. the kit's own example) build correctly.
- Vite plugin now serves the `/__nix-js/render` endpoint (HTML or JSON) used by the SPA router and streaming boundaries.
- ISR now also caches the `/__nix-js/render` endpoint, so streamed pages (with `loading.ts`) regenerate on their `revalidate` TTL instead of being skipped.
- Data loaders (page and layouts) can return a top-level `htmlAttributes` object to set attributes on the `<html>` element of the document shell (e.g. `{ "data-theme": "dark" }`), applied in SSG, SSR and streaming shells — useful for themes persisted via cookie that must survive redirects.
- Data loaders can also return `headScripts: string[]`: inline scripts injected into `<head>` that run synchronously before the first paint and before the deferred client bundle. This is the standard no-flash bootstrap (e.g. applying a stored theme to static pages whose SSG shell was baked with the build-time theme).
- The client router now exports `navigateTo(pathname, search, push)`: a programmatic SPA navigation that fetches the fresh page body from `/__nix-js/render`, swaps `#app`, updates the title and re-hydrates islands. Server actions can use it after a redirect to show fresh server data (e.g. a new review) without a full reload that would serve a stale static page.

### Fixed

- CLI bin re-executes itself under the Bun runtime for bun-managed projects, so apps using `bun:sqlite` work with `nix-js-kit build/dev/start/preview`.
- Attribute interpolation plugin: rewritten with a proper template scanner. Handles nested braces/strings in expressions, single-quoted attributes, comments, and leaves full-value quoted interpolations (`datetime="${x}"`) and unquoted bindings (`value=${() => x}`) untouched.
- Streaming shells now fetch the concrete path (`/blog/:slug` → `/blog/hello-world`) instead of the route pattern.
- Client router now requests JSON (`{ title, body }`) from the render endpoint (titles update on SPA navigation), preserves query strings, and ignores modifier-key clicks.
- Island `data-props` serialization escapes single quotes, so props containing apostrophes hydrate correctly.
- Declaration files are emitted with explicit `.js` extensions, fixing type resolution for NodeNext consumers; the main entry no longer re-exports the CLI or the Vite plugin (use `@deijose/nix-js-kit/cli` / `@deijose/nix-js-kit/vite`), removing the CLI side-effect from adapter bundles.
- Adapters: the SSR entry now embeds the full route table (no runtime filesystem scanning), includes `layout.data.ts` modules in the registry, fixes action resolution by page scope, preserves the query string for page rendering, and serves the `/__nix-js/render` endpoint (HTML or JSON) so the SPA router and streaming keep working in production. Works with Node (`node:sqlite`) and Bun (`bun:sqlite`) runtimes.
- SSR page rendering now forwards the request query string as `searchParams` to loaders.
- Cookies are forwarded to API routes and server actions in every server mode, so auth/middleware that reads the session works in `start`, `preview`, `dev` and the Vite plugin.
- Server actions scoped to dynamic routes now work: the resolver maps concrete page paths (`/movies/inception`) to their route pattern (`/movies/:slug`) in `start`, `preview`, `dev`, the Vite plugin and all adapters.
- The client hydration bundle is now built through a wrapped Vite config that automatically injects the attribute-interpolation plugin, so partial interpolations inside islands (e.g. `href="/movies/${slug}"`) hydrate correctly instead of producing broken attributes.
- `preview` now renders the custom 404/500 error pages instead of plain-text responses.
- The `/__nix-js/render` endpoint returns a clean 404 (instead of a 500 with a stack trace) when the requested path has no matching route, in every server mode and in the adapters.
- Dev server (`nix-js-kit dev`) now runs the actual server in a child process supervised by a watcher: any source change restarts the worker, so page/loader/layout/island edits are always served (previously the ESM module cache served stale modules). Atomic saves (sed/editors) are detected via `rename` events.
- The dev supervisor exits on SIGTERM so stale processes cannot hold the port.

## 1.2.5

### Added

- `layout.data.ts` support: `renderPage` now resolves the nearest `layout.data.ts` loader for each `layout.ts` and passes the returned data to the layout component.
- Data loaders (page and layout) now receive the current `Request` object in their context, enabling SSR auth, cookies, and per-request headers.
- Streaming and SSR servers forward the request to both static and streaming render paths so loaders can read session cookies.

### Changed

- `LayoutProps` data is now populated from `layout.data.ts` when present; `PageProps` retains the `layoutData` slot for future nested layout support.

## 1.2.4

### Fixed

- Client router now re-hydrates islands after navigating to a new page. The generated client entry listens for the `nix-js:rendered` event and mounts islands over the swapped page body.
- Hydration no longer flashes the static markup: it renders the live island into a `DocumentFragment` and swaps the entire island content with `replaceChildren` in one DOM operation.
- Old island effects are disposed before the client router swaps `#app.innerHTML`, preventing leaked effects and stale DOM writes after SPA navigation.
- Vite interpolation plugin rewrites partial attribute interpolations (e.g. `href="/blog/${slug}"`) into a single interpolation in both `src/app` and `src/islands` files during the source transformation step.

## 1.2.3

### Fixed

- Dynamic API routes (`[slug]/route.ts`) now receive route parameters as a second argument (`{ params }`) in `nix-js-kit start`, `preview` and `dev`, matching the behavior already documented for API routes.

## 1.2.2

### Changed

- Server action registry serialized in the HTML shell now exposes only action names per page (`{"/contact":["subscribe"]}`), never file paths or implementation details.
- Client router is no longer inlined in every HTML page. It is bundled into the generated client entry (`/_nix-js/entry-client.js`) via `startClientRouter()` from `@deijose/nix-js-kit/router`, so routing code lives in the JS bundle like other frameworks.

## 1.2.1

### Fixed

- Server action file paths serialized in the HTML shell (`<script id="nix-js-actions">`) are now relative to the project root instead of absolute server paths. This prevents leaking the host file system layout (e.g. `/home/user/...`) in production HTML.

## 1.2.0

### Added

- Vite interpolation plugin transforms partial attribute interpolations (`href="/blog/${slug}"`) into single Nix.js interpolations automatically.
- Source transformation runs before build/dev/start/preview so authors can write natural `href` attributes without manual workarounds.
- Inline client-side router in the HTML shell: intercepts internal link clicks, fetches page body from `/__nix-js/render`, swaps `#app` and updates `history.pushState`.
- `preview` server falls back to on-demand SSR for routes that do not exist in the static `dist/` (e.g. dynamic slugs).
- Client hydration bundle is built automatically when a `vite.client.config.ts` exists.

## 1.1.1

### Added

- Streaming `loading.ts` boundaries: shell renders loading UI and client fetches real content from `/__nix-js/render`.
- `renderStreamingPage` and `renderPageBody` helpers exported.
- `streaming` option for `createSsrServer` (defaults to true when a page has `loading.ts`).

## 1.1.0

### Added

- ISR (Incremental Static Regeneration) with disk-based cache.
- `revalidate` export support in `page.data.ts`.
- `cacheDir` and `defaultRevalidate` options for `createSsrServer` and `nix-js-kit start`.
- Cache helpers exported: `getCachedHtml`, `setCachedHtml`, `clearCache`.
- `renderPage` now returns `{ html, revalidate? }`.

## 1.0.0

### Added

- Official v1.0 release. The framework is now stable with full test coverage.
- All v1.0 roadmap items completed: unit and integration tests, HMR, automatic `PageProps<typeof load>` typing, `nixJsAction`, scoped actions, progressive enhancement, `fail()`/`redirect()`, `route.ts` API endpoints, and `loading.ts` boundary scanning.

## 0.11.7

### Added

- `fail()` and `redirect()` helpers for server actions with client-side detection in `callAction`/`nixJsAction`.
- `route.ts` API endpoints supported in SSR server, Vite dev server, CLI preview/dev, and all adapters.
- `loading.ts` boundary scanned and included in the SSR module registry.
- `matchApiRoute` helper exported for dispatching API routes.
- Tests for `fail()`/`redirect()`, API routes, and loading boundaries.

## 0.11.6

### Added

- Integration test for the preview server (`doPreview`): serves static files and handles server actions.
- `doPreview` now returns the Node `http.Server` instance for easier programmatic control and testing.

## 0.11.5

### Added

- Integration tests for Vercel and Netlify adapters: build handlers and verify SSR responses.
- Integration test for Bun adapter: build server entry and verify it serves SSR with `bun run`.
- Cleanup hooks for Vercel/Netlify/Bun adapter tests.

## 0.11.4

### Added

- Integration tests for static build + SSR server.
- Node adapter integration test: builds `.nix-js/node-server.mjs` and verifies it serves SSR pages.
- Unit tests for `nixJsAction` helper (pending, data, and error signals).
- Cleanup hooks for integration tests to remove temporary `dist/` and `.nix-js/` folders.

## 0.11.3

### Added

- Initial test suite using Node's built-in test runner (`node:test`) and `tsx` for TypeScript imports.
- Tests for `scanRoutes`, `scanActions`, `handleActionRequest` (JSON and form), and `renderPage`.
- `test/fixtures/minimal` with sample pages, data loaders, actions, layout, and a dynamic route.
- `npm test` and `npm run test:watch` scripts.

## 0.11.2

### Added

- `PageProps<typeof load>` and `LayoutProps<typeof load>` now automatically infer the loader's return type (with `Awaited` for async functions).
- README quick example and dynamic route example use `PageProps<typeof load>`.
- Example home page uses `PageProps<typeof load>` instead of a manually exported interface.

## 0.11.1

### Added

- HMR for routes, actions, loaders, and islands in the Vite dev plugin.
- Vite dev plugin now resolves actions via `ssrLoadModule` so changed `page.action.ts` files are reloaded without a server restart.

## 0.11.0

### Added

- `nixJsAction` helper in `@deijose/nix-js-kit/action` with reactive `pending`, `error`, and `data` signals.
- Per-page action scoping: `scanActions` now returns `ActionRegistry` keyed by page URL path.
- `callAction` accepts an optional `{ page }` option to resolve actions scoped to a specific route.
- Progressive enhancement: `POST /__nix-js/actions` also accepts HTML form submissions and redirects back when `Accept: application/json` is missing.

### Changed

- Action registry serialized in `<script id="nix-js-actions">` is now grouped by page path.
- All action resolvers (SSR server, CLI dev/preview, Vite plugin, adapters) resolve by page first, then fall back to a global search.
- `callAction` signature updated to `callAction(name, args, options?)` where `args` can be a single value or an array.
- `callAction` now sends `Accept: application/json` so the server returns JSON instead of a redirect.
- SSR server, CLI dev/preview, and Vite plugin now forward `Content-Type`, `Accept`, and `Referer` headers to the action handler for correct JSON/form negotiation and redirects.
- README updated with `nixJsAction`, scoped actions, and progressive enhancement examples.

## 0.10.0

### Added

- Node adapter: `nix-js-kit adapter node` generates a self-contained `.nix-js/node-server.mjs` that serves `dist/` static files and renders pages on demand.
- New subpath export `@deijose/nix-js-kit/adapters/node`.
- Custom error pages: `src/app/404.page.ts` and `src/app/500.page.ts` are rendered for 404/500 responses during SSG, SSR, and in all deployment adapters.
- `renderErrorPage()` and `RenderErrorPageOptions` exported from `@deijose/nix-js-kit`.

### Changed

- CLI `adapter` command now accepts `vercel`, `netlify`, `bun`, and `node`.
- Route scanner detects `404.page.ts` and `500.page.ts` files and adds `error404`/`error500` to `ScannedRoutes`.
- Static build writes `dist/404.html` and `dist/500.html` when error pages are present.
- README updated with Node adapter and error pages sections.

## 0.9.0

### Added

- Server actions: create `page.action.ts` files next to `page.ts` and call exported functions from the client with `callAction()`.
- New client subpath export `@deijose/nix-js-kit/action` exporting `callAction()` and `ActionRequest`.
- Server-side action endpoint `POST /__nix-js/actions` handled by the CLI (`dev`, `preview`, `start`), the Vite plugin, and all deployment adapters (Vercel, Netlify, Bun).
- New server exports `handleActionRequest`, `ActionResolver` and `scanActions` for custom integrations.
- Document shell now serializes the scanned action registry into `<script id="nix-js-actions">` for client reference.
- Island hydration markers renamed from `data-nix-island` to `data-nix-js-island`.

### Changed

- Route scanner detects `page.action.ts` files and adds `actionPath` to `PageRoute`.
- README updated with a Server actions section and project conventions tree.

## 0.8.1

### Added

- Bun adapter: `nix-js-kit adapter bun` generates `.nix-js/bun-server.ts` and `.nix-js/bun-index.ts` for running a production Bun server.
- New subpath export `@deijose/nix-js-kit/adapters/bun`.

### Changed

- CLI `adapter` command now accepts `vercel`, `netlify` and `bun`.
- README updated with Bun adapter instructions and roadmap v0.9.

## 0.8.0

### Added

- Netlify adapter: `nix-js-kit adapter netlify` generates a Netlify Functions v2 SSR function and `netlify.toml`.
- New subpath export `@deijose/nix-js-kit/adapters/netlify`.
- Shared adapter helpers in `src/adapters/shared.ts` used by both Vercel and Netlify adapters.

### Changed

- CLI `adapter` command now accepts `vercel` and `netlify`.
- README updated with Netlify adapter instructions and roadmap v0.8.

## 0.7.0

### Added

- Vercel adapter: `nix-js-kit adapter vercel` generates a `.vercel/output` directory compatible with the Vercel Build Output API v3.
- New adapter interface in `src/adapters/index.ts`.
- New CLI command `nix-js-kit adapter <name>` (currently supports `vercel`).
- New subpath exports `@deijose/nix-js-kit/adapters` and `@deijose/nix-js-kit/adapters/vercel`.

### Changed

- README updated with adapters section, CLI command list and roadmap v0.7/v0.8.

## 0.6.1

### Changed

- Renamed Vite plugin function from `nixKit` to `nixJsKit` and the options interface from `NixKitViteOptions` to `NixJsKitViteOptions` to keep the `js` word in the public API.
- Updated README, CHANGELOG and example import to use `nixJsKit`.

## 0.6.0

### Added

- Official Vite plugin: `import { nixJsKit } from "@deijose/nix-js-kit/vite"`.
- Vite plugin generates the islands entry automatically and renders pages via SSR on the Vite dev server.
- New subpath export `@deijose/nix-js-kit/vite` for plugin usage.
- Added `example/vite.config.ts` demonstrating the Vite plugin.

### Changed

- README updated with Vite plugin section and roadmap v0.6/v0.7.

## 0.5.0

### Added

- SSR runtime: `nix-js-kit start` renders pages on demand and serves static assets from `dist/`.
- `matchRoute` URL matcher for dynamic and catch-all routes.
- `renderPage` shared renderer used by both SSG and SSR.
- `createSsrServer` exported from the public API for custom Node deployments.

### Changed

- `src/build/build.ts` now uses the shared `renderPage` from `src/ssr/render.ts`.
- CLI help text and README updated to include the `start` command.

## 0.4.2

### Added

- Route groups `(marketing)` support: folders wrapped in parentheses are ignored in the URL path but can provide a shared `layout.ts`.
- Added `example/src/app/(marketing)/` with `pricing` and `features` pages demonstrating route groups.

### Fixed

- Route scanner now reads `layout.ts` from inside the route group directory instead of the parent directory.

## 0.4.1

### Added

- `nix-js-kit preview` command to serve the static build in production mode.
- Clean URL support for static files (e.g. `/about` → `/about/index.html`).

### Changed

- CLI help text and README updated to include the `preview` command.

## 0.4.0

### Added

- `generateStaticParams` export for dynamic routes (`[slug]`) and catch-all routes (`[...slug]`).
- Dynamic routes with `generateStaticParams` are now rendered to static HTML during SSG instead of being skipped.
- `GenerateStaticParams` type exported from the public API.
- Added `example/src/app/blog/[slug]` demonstrating a generated blog post route.

### Changed

- Updated `tsconfig.json` with `paths` mapping so examples can import from `@deijose/nix-js-kit` during development and typechecking.

## 0.3.1

### Changed

- Renamed CLI binary from `nix-kit` to `nix-js-kit` to avoid confusion with the Nix package manager.
- Updated runtime warning prefix from `[nix-kit]` to `[nix-js-kit]`.

## 0.3.0

### Added

- `nix-js-kit` CLI binary with `build` and `dev` commands.
- Dev server (`nix-js-kit dev`) with rebuild-on-change for `src/app/` and `src/islands/`.
- `--client-config` option to rebuild the client hydration bundle on each source change.
- `run()` and `CliOptions` exported from `@deijose/nix-js-kit` for programmatic CLI usage.

### Changed

- `build:lib` now produces a separate SSR build for `dist/lib/cli.js` so the CLI can import user `.ts` files at runtime.
- Added `tsx` as a runtime dependency so the CLI can load user pages and islands without extra setup.

## 0.2.2

### Added

- `scanIslands()` — recursively scans an islands directory; each `.ts` file becomes an island named by its relative path.
- `generateClientEntry()` / `buildEntrySource()` — generates the client hydration entry from scanned islands.
- `build()` now accepts `islandsDir`, `generatedEntry`, and `hydrateImport`; `BuildResult` reports `islands` and `generatedEntry`.
- Second example island (`Counter`) demonstrating multiple islands and the `visible` directive.

## 0.2.1

### Added

- `island()` helper — marks interactive components with `data-nix-island` markers during SSG.
- `hydrateIslands()` — client-side hydration registry with `load`, `idle`, and `visible` directives.
- `example/src/islands/` + `example/src/entry-client.ts` demonstrating a `LikeButton` island.
- `./island` subpath export so client bundles don't pull server-only code.

## 0.2.0

### Added

- `scanRoutes` — file-based route scanner that maps `src/app/page.ts` to URL paths, including dynamic segments (`[slug]`, `[...slug]`).
- `build` — SSG orchestrator that scans `src/app/`, runs loaders, composes layout chains, renders pages, and writes static HTML.
- Example app with two pages (`/`, `/about`) sharing a root layout.

## 0.1.0

### Added

- Initial release of `@deijose/nix-js-kit`.
- `renderToString` for Nix.js templates using `happy-dom` as a build-time DOM (client bundle remains dependency-free).
- `documentShell` helper to wrap rendered HTML with a full document shell and serialize loader data via `<script id="nix-js-data">`.
- Public types: `PageProps`, `LayoutProps`, `PageDataLoad`, `LoadContext`, `RouteParams`, `ShellOptions`.
- Proof-of-concept example under `example/` that generates `dist/index.html` from a `page.ts` + `page.data.ts` pair.
- Vite library build configuration and TypeScript declaration generation.

### Notes

- `linkedom` was evaluated as a lighter DOM alternative but rejected because it does not expose `NodeFilter` in a way compatible with the Nix.js core (`template2.js` reads `NodeFilter.SHOW_ELEMENT` from `globalThis`).
