/**
 * Client-side router for Elur Kit.
 *
 * Intercepts clicks on internal links, fetches the rendered page body from
 * `/__elur-js/render`, swaps the `#app` content and updates the history state.
 * This is loaded as part of the client bundle instead of being inlined in
 * every HTML page.
 *
 * Features:
 * - SPA navigation with head merge (title, meta, OG tags)
 * - Lifecycle events: `elur:navigate-start` / `elur:navigate-end` /
 *   `elur:navigate-error`, plus `elur:before-render` (before the DOM swap) and
 *   `elur:rendered` (after it) so entries can clean up and re-hydrate islands
 * - Element persistence via `data-elur-persist="key"` (Astro/Turbo-style)
 * - Optional DOM morphing (idiomorph) behind `router.morph`
 * - Scroll restoration on back/forward (`history.scrollRestoration = "manual"`)
 * - Network-aware prefetch on hover/focus/pointerdown (Save-Data and
 *   `effectiveType` 2g/slow-2g opt out; `data-prefetch="always"` forces)
 * - Inline `<script>` re-execution and `#elur-data`/`#elur-actions` refresh
 * - View Transitions API with `prefers-reduced-motion` respect
 * - Optional loading indicator (`router.loadingIndicator`)
 */

/**
 * Attribute marking an element whose live DOM node is moved — not re-rendered —
 * across SPA navigations (Astro `transition:persist` / Turbo `permanent`).
 * Matched between the old page and the new payload by the attribute value.
 * Kept as a literal like the other `data-elur-*` hooks below so this module
 * stays import-free for the standalone router chunk.
 */
const PERSIST_ATTR = "data-elur-persist";

interface RenderPayload {
  title?: string | null;
  body: string;
  /** Set-Cookie value relayed by the server to clear a consumed action error. */
  clearActionErrorCookie?: string | null;
  /** `<head>` tags (title, meta, OG, twitter) to merge on navigation. */
  head?: string | null;
  /** Serialized contents of `<script id="elur-data">` for the new page. */
  data?: string | null;
  /** Serialized contents of `<script id="elur-actions">` for the new page. */
  actions?: string | null;
}

/** Detail payload for the `elur:navigate-*` lifecycle events. */
export interface NavigationEventDetail {
  /** Pathname being navigated to (no query string). */
  pathname: string;
  /** Query string including `?`, when present. */
  search: string;
  /** True when the payload came from the prefetch cache instead of the network. */
  fromCache: boolean;
  /** True when the navigation was triggered by back/forward (popstate). */
  popstate: boolean;
}

function dispatchNavigateEvent(
  name: "elur:navigate-start" | "elur:navigate-end" | "elur:navigate-error",
  detail: NavigationEventDetail,
): void {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

/**
 * Whether the `/__elur-js/render` endpoint has been detected. Static builds emit
 * `<meta name="elur:render-endpoint" content="off">` so this starts as
 * `false` with zero probe requests. For older builds, a single shared probe
 * determines availability so concurrent prefetches never storm the endpoint.
 */
let renderEndpointAvailable = true;

/** Shared in-flight probe promise; at most one request hits the endpoint. */
let endpointProbe: Promise<boolean> | null = null;

/** Resolves endpoint availability, caching the result for the page lifetime. */
function resolveEndpointAvailability(): Promise<boolean> {
  if (!renderEndpointAvailable) return Promise.resolve(false);
  if (!endpointProbe) {
    endpointProbe = (async () => {
      const url = new URL("/__elur-js/render", location.origin);
      url.searchParams.set("page", "/");
      try {
        const response = await fetch(url.toString(), {
          headers: { Accept: "application/json", "X-Elur-Probe": "1" },
        });
        renderEndpointAvailable = response.ok;
        return response.ok;
      } catch {
        renderEndpointAvailable = false;
        return false;
      }
    })();
  }
  return endpointProbe;
}

function isInternalLink(link: HTMLAnchorElement): boolean {
  return (
    link.tagName === "A" &&
    link.hostname === location.hostname &&
    link.target === "" &&
    !link.getAttribute("download") &&
    !link.hasAttribute("data-no-router")
  );
}

function hasModifier(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

// --- Prefetch cache ---

const PREFETCH_TTL_MS = 30_000; // 30 seconds
const PREFETCH_CACHE_MAX = 32; // LRU cap — bound memory on long sessions

interface CacheEntry {
  payload: RenderPayload;
  ts: number;
}

const prefetchCache = new Map<string, CacheEntry>();

/** Builds the cache key from pathname + search. */
function cacheKey(pathname: string, search: string): string {
  return pathname + search;
}

/** Returns a cached payload if fresh, refreshing its LRU recency. */
function getCached(key: string): RenderPayload | undefined {
  const entry = prefetchCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > PREFETCH_TTL_MS) {
    prefetchCache.delete(key);
    return undefined;
  }
  // Refresh recency: re-insert so the Map's insertion order reflects use.
  prefetchCache.delete(key);
  prefetchCache.set(key, entry);
  return entry.payload;
}

/** Stores a payload in the prefetch cache, evicting the oldest entry at cap. */
function setCached(key: string, payload: RenderPayload): void {
  prefetchCache.delete(key);
  prefetchCache.set(key, { payload, ts: Date.now() });
  while (prefetchCache.size > PREFETCH_CACHE_MAX) {
    const oldest = prefetchCache.keys().next().value;
    if (oldest === undefined) break;
    prefetchCache.delete(oldest);
  }
}

/**
 * True when prefetching should be skipped to respect constrained networks —
 * quicklink-style guards on Save-Data and slow effective connection types.
 * A link with `data-prefetch="always"` (or a `force` call) bypasses the check.
 */
function prefetchAllowedByNetwork(): boolean {
  const conn = (globalThis.navigator as
    | { connection?: { saveData?: boolean; effectiveType?: string } }
    | undefined)?.connection;
  if (conn?.saveData) return false;
  if (conn?.effectiveType === "slow-2g" || conn?.effectiveType === "2g") return false;
  return true;
}

/**
 * Fetches the render payload for a path. Uses the prefetch cache when fresh.
 * Stores the result in the cache for subsequent navigations.
 *
 * On static deployments (no `/__elur-js/render` endpoint), falls back to
 * fetching the full HTML page and extracting `#app` + `<head>` tags.
 *
 * Returns `{ payload, fromCache }` so navigation events can report whether the
 * content came from the prefetch cache or the network.
 */
async function fetchPayload(
  pathname: string,
  search: string,
  signal?: AbortSignal,
): Promise<{ payload: RenderPayload; fromCache: boolean } | undefined> {
  const key = cacheKey(pathname, search);
  const cached = getCached(key);
  if (cached) return { payload: cached, fromCache: true };

  // Wait on the shared probe so concurrent prefetches generate at most ONE
  // request against the endpoint (the rest go straight to the HTML fallback).
  if (renderEndpointAvailable) {
    if (await resolveEndpointAvailability()) {
      const payload = await fetchFromRenderEndpoint(pathname, search, signal);
      if (payload) {
        setCached(key, payload);
        return { payload, fromCache: false };
      }
      // The endpoint exists but couldn't render this specific page — fall
      // through to the HTML-based fetch without disabling it globally.
    }
  }

  // Static fallback: fetch the full HTML page and extract #app + head.
  const payload = await fetchFromHtml(pathname, search, signal);
  if (payload) {
    setCached(key, payload);
    return { payload, fromCache: false };
  }
  return undefined;
}

/** Attempts to fetch from the `/__elur-js/render` JSON endpoint. */
async function fetchFromRenderEndpoint(pathname: string, search: string, signal?: AbortSignal): Promise<RenderPayload | undefined> {
  const url = new URL("/__elur-js/render", location.origin);
  url.searchParams.set("page", pathname);
  const current = new URL(location.href);
  url.searchParams.set("search", search || current.search);

  let response: Response;
  try {
    response = await fetch(url.toString(), { headers: { Accept: "application/json" }, signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return undefined;
    return undefined;
  }
  if (!response.ok) return undefined;

  let payload: RenderPayload;
  try {
    payload = await response.json();
  } catch {
    return undefined;
  }
  return payload;
}

/**
 * Static-mode fallback: fetches the full HTML page for the path and extracts
 * the `#app` innerHTML plus managed `<head>` tags (`[data-elur-head]`).
 * Also extracts `<title>`, stylesheets, and headLinks for SPA navigation.
 */
async function fetchFromHtml(pathname: string, search: string, signal?: AbortSignal): Promise<RenderPayload | undefined> {
  const fullUrl = pathname + (search || "");
  let response: Response;
  try {
    response = await fetch(fullUrl, { headers: { Accept: "text/html" }, signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return undefined;
    return undefined;
  }
  if (!response.ok) return undefined;

  let html: string;
  try {
    html = await response.text();
  } catch {
    return undefined;
  }

  // Parse the full HTML document.
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // Extract #app innerHTML — this is the page body.
  const appEl = doc.getElementById("app");
  if (!appEl) return undefined;
  const body = appEl.innerHTML;

  // Extract managed head tags (data-elur-head) for mergeHead.
  const headTags = doc.querySelectorAll("[data-elur-head]");
  let head = "";
  for (const tag of headTags) {
    head += tag.outerHTML;
  }

  // Also extract headLinks (favicons, manifest, theme-color) so they persist.
  // These don't have data-elur-head, so we grab them separately.
  const linkTags = doc.head.querySelectorAll("link[rel='icon'], link[rel='apple-touch-icon'], link[rel='manifest'], meta[name='theme-color']");
  for (const tag of linkTags) {
    // Skip if already in the current document head
    const href = tag.getAttribute("href");
    if (href && document.head.querySelector(`link[href="${href}"]`)) continue;
    head += tag.outerHTML;
  }

  const title = doc.querySelector("title")?.textContent ?? undefined;

  // Keep the inert JSON scripts in sync across navigations (same fields the
  // render endpoint returns): without this they stay frozen with the initial
  // page's loader data and action registry.
  const dataEl = doc.getElementById("elur-data");
  const actionsEl = doc.getElementById("elur-actions");

  return {
    body,
    head,
    title,
    data: dataEl?.textContent ?? undefined,
    actions: actionsEl?.textContent ?? undefined,
  };
}

/**
 * Prefetches a path without navigating. Called by the IntersectionObserver
 * when a link enters the viewport, and on hover/focus/pointerdown.
 *
 * Skipped on constrained networks (Save-Data or a 2g-class effective type)
 * unless `force` is set — e.g. `data-prefetch="always"` links.
 */
export async function prefetch(
  pathname: string,
  search = "",
  options?: { force?: boolean },
): Promise<void> {
  if (options?.force !== true && !prefetchAllowedByNetwork()) return;
  const key = cacheKey(pathname, search);
  if (prefetchCache.has(key)) {
    // Already cached or in-flight — skip.
    const entry = prefetchCache.get(key)!;
    if (Date.now() - entry.ts <= PREFETCH_TTL_MS) return;
  }
  await fetchPayload(pathname, search);
}

// --- View Transitions ---

/** Returns true if the user prefers reduced motion. */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Returns true if the View Transitions API is available. */
function supportsViewTransitions(): boolean {
  return typeof (document as any).startViewTransition === "function";
}

// --- Navigation ---

/**
 * Guard against concurrent navigations. When a navigation is in-flight, a new
 * request cancels the previous one (abort + ignore its result). This prevents
 * race conditions where two rapid clicks could swap content out of order.
 */
let inFlightNavigation: {
  controller: AbortController;
  pathname: string;
} | null = null;

/**
 * Cancels any in-flight navigation so a new one can proceed cleanly.
 */
function cancelInFlightNavigation(): void {
  if (inFlightNavigation) {
    inFlightNavigation.controller.abort();
    inFlightNavigation = null;
  }
}

/**
 * Hoists `<link rel="stylesheet">` and `<style>` tags from inside `#app` into
 * `<head>` so they persist across SPA navigations (prevents FOUC/flashing).
 * Deduplicates by `href` for links and by text content for styles.
 */
export function hoistStyles(container: ParentNode): void {
  const links = container.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]');
  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href) continue;
    // Already in <head>?
    const existing = document.head.querySelector(`link[rel="stylesheet"][href="${href}"]`);
    if (existing) {
      link.remove();
      continue;
    }
    // Mark as hoisted so we can clean up later if needed
    link.setAttribute("data-elur-hoisted", "");
    document.head.appendChild(link);
  }

  const styles = container.querySelectorAll<HTMLStyleElement>("style");
  for (const style of styles) {
    const text = style.textContent?.trim();
    if (!text) continue;
    // Check if an identical style already exists in <head>
    const existing = Array.from(document.head.querySelectorAll("style")).find(
      (s) => s.textContent?.trim() === text,
    );
    if (existing) {
      style.remove();
      continue;
    }
    style.setAttribute("data-elur-hoisted", "");
    document.head.appendChild(style);
  }
}

/**
 * Announces a route change to assistive technology via an aria-live region.
 * This is critical for screen reader users who need to know the page content
 * has changed after a SPA navigation.
 */
function announceNavigation(pathname: string): void {
  let liveRegion = document.getElementById("elur-route-announcer");
  if (!liveRegion) {
    liveRegion = document.createElement("div");
    liveRegion.id = "elur-route-announcer";
    liveRegion.setAttribute("aria-live", "assertive");
    liveRegion.setAttribute("aria-atomic", "true");
    liveRegion.setAttribute("role", "status");
    // Visually hidden but available to screen readers.
    liveRegion.setAttribute("style", "position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;");
    document.body.appendChild(liveRegion);
  }
  // Clear and re-set so screen readers announce the change.
  liveRegion.textContent = "";
  // Use a microtask delay so the DOM update is picked up by AT.
  // Guard against the document being torn down (e.g. in tests).
  const region = liveRegion;
  const timer = setTimeout(() => {
    if (typeof document !== "undefined" && region) {
      const title = document.title || pathname;
      region.textContent = title;
    }
  }, 50);
  // Don't keep the process alive just for the announcer.
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

/**
 * Moves focus to the main content area after a SPA navigation. This follows
 * the WAI-ARIA pattern for route changes: if the #app has a tabindex=-1, focus
 * it; otherwise create a temporary focus target.
 */
function moveFocusToContent(): void {
  const app = document.getElementById("app");
  if (!app) return;
  // Ensure the container is focusable.
  if (!app.hasAttribute("tabindex")) {
    app.setAttribute("tabindex", "-1");
  }
  // Remove outline only for mouse users; keyboard users keep it.
  app.focus({ preventScroll: false });
}

/**
 * Updates the canonical URL and og:url meta tags after navigation.
 */
function updateCanonicalUrl(pathname: string, search: string): void {
  const fullUrl = location.origin + pathname + (search || "");
  // Update or create canonical link.
  let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.rel = "canonical";
    document.head.appendChild(canonical);
  }
  canonical.href = fullUrl;
  // Update og:url meta.
  let ogUrl = document.querySelector<HTMLMetaElement>('meta[property="og:url"]');
  if (!ogUrl) {
    ogUrl = document.createElement("meta");
    ogUrl.setAttribute("property", "og:url");
    document.head.appendChild(ogUrl);
  }
  ogUrl.content = fullUrl;
}

// --- Element persistence (data-elur-persist) ---

/**
 * Computes which `[data-elur-persist]` nodes of the current page have a
 * counterpart — same attribute value — in the incoming fragment. The plan is
 * computed before any mutation so listeners of `elur:before-render` know
 * exactly which subtrees will survive the swap (islands inside them are
 * excluded from cleanup).
 */
function planPersistedNodes(app: HTMLElement, fragment: DocumentFragment): { oldEl: Element; newEl: Element }[] {
  const oldNodes = app.querySelectorAll(`[${PERSIST_ATTR}]`);
  if (oldNodes.length === 0) return [];
  const plan: { oldEl: Element; newEl: Element }[] = [];
  for (const oldEl of oldNodes) {
    const key = oldEl.getAttribute(PERSIST_ATTR);
    if (!key) continue;
    // A persisted ancestor already carries this subtree with it.
    if (plan.some((p) => p.oldEl.contains(oldEl))) continue;
    const newEl = fragment.querySelector(`[${PERSIST_ATTR}="${cssEscape(key)}"]`);
    if (!newEl) continue;
    plan.push({ oldEl, newEl });
  }
  return plan;
}

/** CSS.escape with a minimal fallback for environments lacking it. */
function cssEscape(value: string): string {
  const esc = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
  return esc ? esc(value) : value.replace(/["\\\]]/g, "\\$&");
}

/**
 * Moves each persisted node's LIVE element into the position of its match in
 * the new content. `Element.moveBefore()` (Chrome 133+) preserves the state of
 * iframes/video/canvas during the move; `replaceWith` is the fallback.
 *
 * Props conflicts are resolved in favor of the persisted node (v1): the old
 * subtree keeps its own props/state. When an island inside a persisted node
 * would receive different props on the new page, an `elur:persist-props-changed`
 * event bubbles from the island marker so apps can react if they choose to.
 */
function movePersistedNodes(plan: { oldEl: Element; newEl: Element }[]): void {
  for (const { oldEl, newEl } of plan) {
    reportPersistPropChanges(oldEl, newEl);
    const parent = newEl.parentNode as (Node & { moveBefore?: (node: Node, ref: Node) => void }) | null;
    if (parent && typeof parent.moveBefore === "function") {
      parent.moveBefore(oldEl, newEl);
      newEl.remove();
    } else {
      newEl.replaceWith(oldEl);
    }
  }
}

/**
 * Dispatches `elur:persist-props-changed` for islands whose props changed.
 *
 * Known limitation (v1): islands are matched by NAME inside each persisted
 * subtree — two islands with the same registry name inside the same
 * `data-elur-persist` node collide in the props map (last one wins).
 * Persisted nodes are typically singletons (player, sidebar), so this is
 * acceptable for v1.
 */
function reportPersistPropChanges(oldEl: Element, newEl: Element): void {
  const islandsOf = (root: Element) => {
    const list = (root.matches?.("[data-elur-island]") ? [root] : []) as Element[];
    return list.concat(Array.from(root.querySelectorAll("[data-elur-island]")));
  };
  const newPropsByName = new Map<string, string | null>();
  for (const el of islandsOf(newEl)) {
    const name = el.getAttribute("data-elur-island");
    if (name) newPropsByName.set(name, el.getAttribute("data-props"));
  }
  for (const el of islandsOf(oldEl)) {
    const name = el.getAttribute("data-elur-island");
    if (!name) continue;
    const next = newPropsByName.get(name);
    const prev = el.getAttribute("data-props");
    if (next !== undefined && next !== prev) {
      el.dispatchEvent(
        new CustomEvent("elur:persist-props-changed", {
          bubbles: true,
          detail: { name, props: next, previousProps: prev },
        }),
      );
    }
  }
}

// --- Inline <script> re-execution ---

/**
 * `src` values already executed during this session. Seeded lazily with every
 * script present in the document so a page's own scripts never re-run and the
 * shell's module entries are never re-fetched.
 */
let executedScriptSrcs: Set<string> | null = null;

const EXECUTABLE_SCRIPT_TYPES = new Set(["", "text/javascript", "application/javascript", "module"]);

/**
 * Re-executes `<script>` elements inside the swapped content. Scripts injected
 * via innerHTML are inert, so each one is cloned and re-inserted — the same
 * trick Astro uses. External scripts are deduplicated by absolute `src` across
 * navigations; inline scripts run on every navigation. Opt out per script with
 * `data-elur-no-reload`.
 */
function reexecuteScripts(container: ParentNode): void {
  if (!executedScriptSrcs) {
    executedScriptSrcs = new Set(
      Array.from(document.querySelectorAll("script[src]"))
        .map((s) => s.getAttribute("src"))
        .filter((s): s is string => !!s)
        .map((s) => new URL(s, location.href).href),
    );
  }
  for (const script of Array.from(container.querySelectorAll("script"))) {
    if (script.hasAttribute("data-elur-no-reload")) continue;
    if (!EXECUTABLE_SCRIPT_TYPES.has(script.type)) continue;
    const src = script.getAttribute("src");
    if (src) {
      const abs = new URL(src, location.href).href;
      if (executedScriptSrcs.has(abs)) continue;
      executedScriptSrcs.add(abs);
    }
    const clone = document.createElement("script");
    for (const attr of Array.from(script.attributes)) {
      clone.setAttribute(attr.name, attr.value);
    }
    clone.textContent = script.textContent;
    script.replaceWith(clone);
  }
}

/**
 * Replaces the contents of the inert `<script id="...">` JSON payloads so they
 * reflect the current page. When the new payload lacks the field, a stale
 * element is removed rather than left frozen.
 */
function syncJsonScript(id: string, content: string | undefined): void {
  const existing = document.getElementById(id);
  if (content === undefined) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.textContent = content;
    return;
  }
  const el = document.createElement("script");
  el.type = "application/json";
  el.id = id;
  el.textContent = content;
  document.body.appendChild(el);
}

// --- DOM morphing (opt-in, idiomorph) ---

let morphEnabled = false;

/**
 * True for nodes the morpher must treat as opaque: hydrated islands (they own
 * their DOM through signals) and persisted subtrees (moved verbatim by the
 * persistence pass — re-morphing them would defeat the point).
 */
function isOpaqueToMorph(node: Node): boolean {
  if (node instanceof Element) {
    if (node.hasAttribute(PERSIST_ATTR)) return true;
    if (typeof (node as { __elur_js_island_dispose?: unknown }).__elur_js_island_dispose === "function") {
      return true;
    }
  }
  return false;
}

/**
 * Morphs `app` children toward the new content using idiomorph instead of a
 * wholesale `replaceChildren`. Only reached when `router.morph` is enabled.
 * On any failure the caller falls back to the plain swap.
 */
async function morphApp(app: HTMLElement, fragment: DocumentFragment): Promise<void> {
  const { Idiomorph } = await import("idiomorph");
  // Wrap the fragment in a dummy parent: idiomorph's innerHTML style morphs
  // the element's children against another parent's children.
  const wrapper = document.createElement("div");
  wrapper.appendChild(fragment);
  Idiomorph.morph(app, wrapper, {
    morphStyle: "innerHTML",
    callbacks: {
      beforeNodeMorphed: (node) => (isOpaqueToMorph(node) ? false : undefined),
    },
  });
}

/**
 * Navigates to a page without a full reload: fetches the fresh body from the
 * `/__elur-js/render` endpoint, swaps `#app`, updates the document title and
 * dispatches `elur:before-render` + `elur:rendered` so islands are cleaned up
 * and re-hydrated. Used by the router on clicks and available for programmatic
 * navigation (e.g. after a server action returns a redirect, so the target
 * page shows fresh server data).
 *
 * Concurrent navigations are handled: a new navigateTo() cancels any
 * in-flight navigation to prevent out-of-order content swaps.
 *
 * Lifecycle events (`elur:navigate-start` / `elur:navigate-end` /
 * `elur:navigate-error`) carry `{ pathname, search, fromCache, popstate }` —
 * enough for a loading indicator in a few lines of user code.
 *
 * @param pathname Path without query, e.g. "/movies/inception".
 * @param search Query string, e.g. "?reviewed=1" (optional).
 * @param push Whether to push a history entry (default true).
 * @returns true on success, false if the render failed.
 */
export async function navigateTo(pathname: string, search = "", push = true): Promise<boolean> {
  const popstate = !push;
  // Cancel any previous in-flight navigation to prevent race conditions.
  cancelInFlightNavigation();

  const controller = new AbortController();
  inFlightNavigation = { controller, pathname };

  const detailBase = { pathname, search, popstate };
  dispatchNavigateEvent("elur:navigate-start", {
    ...detailBase,
    fromCache: getCached(cacheKey(pathname, search)) !== undefined,
  });

  let result: { payload: RenderPayload; fromCache: boolean } | undefined;
  try {
    result = await fetchPayload(pathname, search, controller.signal);
  } catch (err) {
    // Superseded navigations stay silent: the newer navigation already
    // emitted its own navigate-start and owns the lifecycle events — an error
    // here would wrongly resolve it (e.g. hide a loading indicator mid-nav).
    if (controller.signal.aborted) return false;
    dispatchNavigateEvent("elur:navigate-error", { ...detailBase, fromCache: false });
    throw err;
  }

  // If a newer navigation started while we were fetching, bail out silently.
  if (inFlightNavigation && inFlightNavigation.controller !== controller) {
    if (controller.signal.aborted) return false;
  }
  inFlightNavigation = null;

  if (!result) {
    dispatchNavigateEvent("elur:navigate-error", { ...detailBase, fromCache: false });
    return false;
  }
  const { payload, fromCache } = result;

  const app = document.getElementById("app");
  if (!app) {
    dispatchNavigateEvent("elur:navigate-error", { ...detailBase, fromCache });
    return false;
  }

  // Save scroll position in the current history entry before navigating.
  if (push) {
    history.replaceState(
      { n: location.pathname, scroll: window.scrollY },
      "",
      location.href,
    );
  }

  const current = new URL(location.href);
  const doSwap = async () => {
    // Save scroll positions of scrollable elements (e.g. sidebar) before swap
    const scrollables: { el: Element; top: number }[] = [];
    app.querySelectorAll("[data-scroll-preserve]").forEach((el) => {
      scrollables.push({ el, top: el.scrollTop });
    });

    // Hoist any stylesheets from the current #app content to <head> before
    // the swap, so they persist and don't cause a flash.
    hoistStyles(app);

    // Parse the new body and hoist its styles before injecting, so the
    // browser never sees a frame without styles.
    const buildFragment = () => {
      const t = document.createElement("template");
      t.innerHTML = payload.body;
      hoistStyles(t.content as unknown as HTMLElement);
      return t.content;
    };
    const tempContent = buildFragment();

    // Persistence pass: decide which live nodes move into the new content.
    const persistPlan = planPersistedNodes(app, tempContent);

    // Notify listeners BEFORE touching the DOM: this is where the client
    // entry disposes islands (still attached, so cleanup can read live DOM)
    // except the ones inside persisted nodes.
    document.dispatchEvent(
      new CustomEvent("elur:before-render", {
        detail: { ...detailBase, persisted: persistPlan.map((p) => p.oldEl) },
      }),
    );

    movePersistedNodes(persistPlan);

    if (morphEnabled) {
      try {
        await morphApp(app, tempContent);
      } catch {
        // morphApp consumes the fragment (persisted nodes may already be
        // inside it): rebuild fresh content and rescue the live persisted
        // nodes from the plan — wherever the failed morph left them.
        const fresh = buildFragment();
        const rescue: { oldEl: Element; newEl: Element }[] = [];
        for (const newEl of fresh.querySelectorAll(`[${PERSIST_ATTR}]`)) {
          const key = newEl.getAttribute(PERSIST_ATTR);
          const oldEl = persistPlan.find(
            (p) => p.oldEl.getAttribute(PERSIST_ATTR) === key,
          )?.oldEl;
          if (oldEl) rescue.push({ oldEl, newEl });
        }
        movePersistedNodes(rescue);
        app.replaceChildren(fresh);
      }
    } else {
      app.replaceChildren(tempContent);
    }
    mergeHead(payload.head, payload.title);
    if (payload.clearActionErrorCookie) {
      document.cookie = payload.clearActionErrorCookie;
    }
    if (push) {
      history.pushState({ n: pathname, scroll: 0 }, "", pathname + (search || current.search));
    }
    const savedScroll = push ? 0 : (history.state?.scroll ?? 0);
    window.scrollTo(0, savedScroll);

    // Restore scroll positions of preserved elements
    for (const s of scrollables) {
      const newEl = app.querySelector(`[data-scroll-preserve="${s.el.getAttribute("data-scroll-preserve")}"]`);
      if (newEl) newEl.scrollTop = s.top;
    }

    // Update canonical URL and OG tags for the new route.
    updateCanonicalUrl(pathname, search);

    // Refresh the inert JSON payloads (#elur-data / #elur-actions).
    syncJsonScript("elur-data", payload.data ?? undefined);
    syncJsonScript("elur-actions", payload.actions ?? undefined);

    // Re-execute page scripts that innerHTML left inert.
    reexecuteScripts(app);

    // Announce the navigation to screen readers.
    announceNavigation(pathname);

    // Move focus to the main content for keyboard/screen reader users.
    // Only on push (forward navigation), not on back/forward (popstate).
    if (push) moveFocusToContent();

    document.dispatchEvent(new CustomEvent("elur:rendered", { detail: detailBase }));
  };

  // Use View Transitions when available and the user hasn't opted out.
  const useTransition = supportsViewTransitions() && !prefersReducedMotion();
  if (useTransition) {
    const vt = (document as any).startViewTransition(() => doSwap());
    // navigate-end must fire after the DOM update, not when the animation
    // finishes — updateCallbackDone resolves once the swap callback ran.
    // It rejects when the transition is skipped (e.g. hidden tab): the swap
    // still happened, so the rejection is not a navigation error.
    try {
      await vt.updateCallbackDone;
    } catch {
      // skipped transition — the update callback already ran or was skipped
    }
  } else {
    await doSwap();
  }

  dispatchNavigateEvent("elur:navigate-end", { ...detailBase, fromCache });
  return true;
}

/**
 * Replaces all `<head>` tags marked with `data-elur-head` with the new ones
 * from the server payload. Also updates `document.title` when a title tag is
 * present in the new head.
 */
function mergeHead(head: string | null | undefined, fallbackTitle: string | null | undefined): void {
  // Remove existing managed tags.
  const existing = document.querySelectorAll("[data-elur-head]");
  existing.forEach((el) => el.remove());

  if (head && head.trim().length > 0) {
    // Parse the head tags from the server and insert them into <head>.
    const parser = document.createElement("template");
    parser.innerHTML = head;
    const fragment = parser.content;
    // Extract the <title> if present and set document.title directly.
    const titleEl = fragment.querySelector("title");
    if (titleEl) {
      document.title = titleEl.textContent ?? "";
      titleEl.remove();
    }
    document.head.appendChild(fragment);
  } else if (fallbackTitle) {
    document.title = fallbackTitle;
  }
}

// --- Link prefetch observers ---

/** Set of links currently being observed for prefetch. */
const observedLinks = new WeakSet<HTMLAnchorElement>();

/**
 * Sets up prefetch on internal links. Default is interaction-only (hover or
 * focus) — the same behavior as Astro — so a page load never fires a burst of
 * fetches for every link in the viewport. Links can opt into viewport
 * prefetching with `data-prefetch="viewport"`.
 */
function setupLinkPrefetch(): void {
  const linkInfo = (link: HTMLAnchorElement) => {
    const href = link.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:")) {
      return null;
    }
    const qIndex = href.indexOf("?");
    return {
      path: qIndex === -1 ? href : href.slice(0, qIndex),
      search: qIndex === -1 ? "" : href.slice(qIndex),
    };
  };

  const observeLink = (link: HTMLAnchorElement) => {
    if (observedLinks.has(link)) return;
    if (!isInternalLink(link) || link.hasAttribute("data-no-prefetch")) return;
    observedLinks.add(link);

    // Interaction prefetch (default): hover, focus or pointerdown. The
    // pointerdown listener is the "tap" strategy — it starts the fetch
    // earlier than the click on touch devices.
    const onInteract = () => {
      const info = linkInfo(link);
      if (info) void prefetch(info.path, info.search, { force: link.dataset.prefetch === "always" });
    };
    link.addEventListener("pointerenter", onInteract, { once: true });
    link.addEventListener("focus", onInteract, { once: true });
    link.addEventListener("pointerdown", onInteract, { once: true });

    // Opt-in viewport prefetch via data-prefetch="viewport".
    if (link.dataset.prefetch === "viewport" && "IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const info = linkInfo(entry.target as HTMLAnchorElement);
            if (info) void prefetch(info.path, info.search);
            observer.disconnect();
          }
        },
        { rootMargin: "200px", threshold: 0 },
      );
      observer.observe(link);
    }
  };

  const observeLinks = () => {
    const links = document.querySelectorAll<HTMLAnchorElement>("a[href]");
    for (const link of links) observeLink(link);
  };

  observeLinks();

  // Re-scan when the DOM changes (e.g. after SPA navigation).
  const mutationObserver = new MutationObserver(() => observeLinks());
  mutationObserver.observe(document.body, { childList: true, subtree: true });

  // Re-scan after each SPA navigation.
  document.addEventListener("elur:rendered", observeLinks);
}

// --- Loading indicator (opt-in) ---

const LOADING_INDICATOR_DELAY_MS = 200;
const LOADING_INDICATOR_ID = "elur-loading-indicator";

/**
 * Progress-bar style loading indicator driven by the `elur:navigate-*`
 * lifecycle events. Hidden by default; appears only when a navigation takes
 * longer than ~200 ms (fast navigations never flash it) and is skipped for
 * cache hits. Honors `prefers-reduced-motion` by showing a static bar
 * instead of a trickle animation.
 */
function startLoadingIndicator(): void {
  if (typeof document === "undefined") return;
  let bar: HTMLDivElement | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let trickleTimer: ReturnType<typeof setInterval> | null = null;
  let progress = 0;

  const reducedMotion = () => prefersReducedMotion();

  const paint = () => {
    if (!bar) return;
    bar.style.transform = `scaleX(${Math.min(progress, 100) / 100})`;
  };

  const show = () => {
    if (bar) return;
    bar = document.createElement("div");
    bar.id = LOADING_INDICATOR_ID;
    // Decorative only — AT users get the aria-live route announcer instead,
    // so a role would be redundant and aria-hidden would contradict it.
    bar.setAttribute("aria-hidden", "true");
    Object.assign(bar.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      height: "2px",
      background: "currentColor",
      color: "var(--elur-loading-color, #4f7cff)",
      transform: "scaleX(0)",
      transformOrigin: "0 50%",
      transition: reducedMotion() ? "none" : "transform 150ms ease-out, opacity 200ms ease-in",
      zIndex: "2147483647",
      pointerEvents: "none",
      opacity: "1",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(bar);
    progress = 10;
    paint();
    if (!reducedMotion()) {
      // NProgress-style trickle: approach ~80% asymptotically while the
      // navigation is still in flight.
      trickleTimer = setInterval(() => {
        progress += (80 - progress) * 0.12;
        paint();
      }, 150);
    }
  };

  const finish = () => {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    if (trickleTimer) {
      clearInterval(trickleTimer);
      trickleTimer = null;
    }
    if (!bar) return;
    progress = 100;
    paint();
    const el = bar;
    bar = null;
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), reducedMotion() ? 0 : 200);
    }, 120);
  };

  document.addEventListener("elur:navigate-start", (event) => {
    const detail = (event as CustomEvent).detail as NavigationEventDetail | undefined;
    if (detail?.fromCache) return; // cache hits are instant — no indicator
    finish(); // reset any previous pending state
    showTimer = setTimeout(show, LOADING_INDICATOR_DELAY_MS);
  });
  document.addEventListener("elur:navigate-end", finish);
  document.addEventListener("elur:navigate-error", finish);
}

// --- Router bootstrap ---

export interface ClientRouterOptions {
  /**
   * Link prefetching on hover/focus/pointerdown (and opt-in viewport).
   * Default: `true`. Pass `false` to disable all prefetch traffic.
   */
  prefetch?: boolean;
  /**
   * Swap `#app` with idiomorph-based DOM morphing instead of a wholesale
   * replace. Experimental — hydrated islands and `data-elur-persist` nodes
   * are treated as opaque. Default: `false`.
   */
  morph?: boolean;
  /**
   * Show a minimal top progress bar on navigations slower than ~200 ms.
   * Default: `false`.
   */
  loadingIndicator?: boolean;
}

/** Guard: the router is a singleton — starting it twice must not double-bind listeners. */
let routerStarted = false;

export function startClientRouter(options: ClientRouterOptions = {}): void {
  // Option-derived flags are re-applied on every call — after Vite HMR
  // re-runs the generated entry, changed flags (e.g. router.morph) take
  // effect without a full reload. Listener-bound behavior (prefetch,
  // loading indicator) is registered once and still requires a reload.
  morphEnabled = options.morph === true;
  if (routerStarted) return;
  routerStarted = true;

  // We manage scroll ourselves (save/restore per history entry); tell the
  // browser not to interfere on back/forward.
  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }

  // Static builds emit this marker, so the client never probes the render
  // endpoint (zero 404s on fully static deployments). The meta lives in the
  // initial HTML head and persists across SPA navigations.
  const endpointMeta = document.querySelector<HTMLMetaElement>(
    'meta[name="elur:render-endpoint"]',
  );
  if (endpointMeta?.getAttribute("content") === "off") {
    renderEndpointAvailable = false;
  }

  // Hoist styles from #app to <head> immediately on page load.
  // This prevents FOUC on the first SPA navigation.
  const app = document.getElementById("app");
  if (app) hoistStyles(app);

  document.addEventListener("click", async (event) => {
    if (!(event instanceof MouseEvent) || hasModifier(event)) return;
    if (event.defaultPrevented) return;
    const link = (event.target as HTMLElement).closest("a");
    if (!link || !isInternalLink(link as HTMLAnchorElement)) return;

    const href = link.getAttribute("href");
    if (!href || href.startsWith("mailto:") || href.startsWith("javascript:")) return;

    // Handle hash links: scroll to the element if it exists on the page
    if (href.startsWith("#")) {
      if (href.length > 1) {
        const target = document.getElementById(href.slice(1));
        if (target) {
          event.preventDefault();
          target.scrollIntoView({ behavior: "smooth", block: "start" });
          history.replaceState(null, "", href);
        }
      }
      return;
    }

    event.preventDefault();
    const qIndex = href.indexOf("?");
    const path = qIndex === -1 ? href : href.slice(0, qIndex);
    const search = qIndex === -1 ? "" : href.slice(qIndex);
    if (!(await navigateTo(path, search))) {
      location.assign(href);
    }
  });

  window.addEventListener("popstate", (event) => {
    const state = event.state as { n?: string; scroll?: number } | null;
    const target = state?.n ?? location.pathname;
    void navigateTo(target, location.search, false);
  });

  if (options.prefetch !== false) setupLinkPrefetch();
  if (options.loadingIndicator === true) startLoadingIndicator();
}

// --- Test helpers (not part of the public API) ---

/**
 * Resets all internal router state. Intended for test isolation only.
 * @internal
 */
export function __resetRouterState(): void {
  prefetchCache.clear();
  inFlightNavigation = null;
  renderEndpointAvailable = true;
  endpointProbe = null;
  executedScriptSrcs = null;
  morphEnabled = false;
  routerStarted = false;
}

