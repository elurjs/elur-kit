/**
 * Client-side router for Nix.js Kit.
 *
 * Intercepts clicks on internal links, fetches the rendered page body from
 * `/__nix-js/render`, swaps the `#app` content and updates the history state.
 * This is loaded as part of the client bundle instead of being inlined in
 * every HTML page.
 *
 * Features:
 * - SPA navigation with head merge (title, meta, OG tags)
 * - Scroll restoration on back/forward
 * - Prefetch on hover/focus (Astro-style), with opt-in viewport prefetch
 * - View Transitions API with `prefers-reduced-motion` respect
 */

interface RenderPayload {
  title?: string;
  body: string;
  /** Set-Cookie value relayed by the server to clear a consumed action error. */
  clearActionErrorCookie?: string;
  /** `<head>` tags (title, meta, OG, twitter) to merge on navigation. */
  head?: string;
}

/**
 * Whether the `/__nix-js/render` endpoint has been detected. Static builds emit
 * `<meta name="nix-js:render-endpoint" content="off">` so this starts as
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
      const url = new URL("/__nix-js/render", location.origin);
      url.searchParams.set("page", "/");
      try {
        const response = await fetch(url.toString(), {
          headers: { Accept: "application/json", "X-Nix-Probe": "1" },
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

interface CacheEntry {
  payload: RenderPayload;
  ts: number;
}

const prefetchCache = new Map<string, CacheEntry>();

/** Builds the cache key from pathname + search. */
function cacheKey(pathname: string, search: string): string {
  return pathname + search;
}

/** Returns a cached payload if fresh, otherwise undefined. */
function getCached(key: string): RenderPayload | undefined {
  const entry = prefetchCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > PREFETCH_TTL_MS) {
    prefetchCache.delete(key);
    return undefined;
  }
  return entry.payload;
}

/** Stores a payload in the prefetch cache. */
function setCached(key: string, payload: RenderPayload): void {
  prefetchCache.set(key, { payload, ts: Date.now() });
}

/**
 * Fetches the render payload for a path. Uses the prefetch cache when fresh.
 * Stores the result in the cache for subsequent navigations.
 *
 * On static deployments (no `/__nix-js/render` endpoint), falls back to
 * fetching the full HTML page and extracting `#app` + `<head>` tags.
 */
async function fetchPayload(pathname: string, search: string, signal?: AbortSignal): Promise<RenderPayload | undefined> {
  const key = cacheKey(pathname, search);
  const cached = getCached(key);
  if (cached) return cached;

  // Wait on the shared probe so concurrent prefetches generate at most ONE
  // request against the endpoint (the rest go straight to the HTML fallback).
  if (renderEndpointAvailable) {
    if (await resolveEndpointAvailability()) {
      const payload = await fetchFromRenderEndpoint(pathname, search, signal);
      if (payload) {
        setCached(key, payload);
        return payload;
      }
      // The endpoint exists but couldn't render this specific page — fall
      // through to the HTML-based fetch without disabling it globally.
    }
  }

  // Static fallback: fetch the full HTML page and extract #app + head.
  const payload = await fetchFromHtml(pathname, search, signal);
  if (payload) {
    setCached(key, payload);
  }
  return payload;
}

/** Attempts to fetch from the `/__nix-js/render` JSON endpoint. */
async function fetchFromRenderEndpoint(pathname: string, search: string, signal?: AbortSignal): Promise<RenderPayload | undefined> {
  const url = new URL("/__nix-js/render", location.origin);
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
 * the `#app` innerHTML plus managed `<head>` tags (`[data-nix-js-head]`).
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

  // Extract managed head tags (data-nix-js-head) for mergeHead.
  const headTags = doc.querySelectorAll("[data-nix-js-head]");
  let head = "";
  for (const tag of headTags) {
    head += tag.outerHTML;
  }

  // Also extract headLinks (favicons, manifest, theme-color) so they persist.
  // These don't have data-nix-js-head, so we grab them separately.
  const linkTags = doc.head.querySelectorAll("link[rel='icon'], link[rel='apple-touch-icon'], link[rel='manifest'], meta[name='theme-color']");
  for (const tag of linkTags) {
    // Skip if already in the current document head
    const href = tag.getAttribute("href");
    if (href && document.head.querySelector(`link[href="${href}"]`)) continue;
    head += tag.outerHTML;
  }

  const title = doc.querySelector("title")?.textContent ?? undefined;

  return { body, head, title };
}

/**
 * Prefetches a path without navigating. Called by the IntersectionObserver
 * when a link enters the viewport, and on hover/focus.
 */
export async function prefetch(pathname: string, search = ""): Promise<void> {
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
    link.setAttribute("data-nix-js-hoisted", "");
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
    style.setAttribute("data-nix-js-hoisted", "");
    document.head.appendChild(style);
  }
}

/**
 * Announces a route change to assistive technology via an aria-live region.
 * This is critical for screen reader users who need to know the page content
 * has changed after a SPA navigation.
 */
function announceNavigation(pathname: string): void {
  let liveRegion = document.getElementById("nix-js-route-announcer");
  if (!liveRegion) {
    liveRegion = document.createElement("div");
    liveRegion.id = "nix-js-route-announcer";
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

/**
 * Navigates to a page without a full reload: fetches the fresh body from the
 * `/__nix-js/render` endpoint, swaps `#app`, updates the document title and
 * dispatches `nix-js:rendered` so islands re-hydrate. Used by the router on
 * clicks and available for programmatic navigation (e.g. after a server
 * action returns a redirect, so the target page shows fresh server data).
 *
 * Concurrent navigations are handled: a new navigateTo() cancels any
 * in-flight navigation to prevent out-of-order content swaps.
 *
 * @param pathname Path without query, e.g. "/movies/inception".
 * @param search Query string, e.g. "?reviewed=1" (optional).
 * @param push Whether to push a history entry (default true).
 * @returns true on success, false if the render failed.
 */
export async function navigateTo(pathname: string, search = "", push = true): Promise<boolean> {
  // Cancel any previous in-flight navigation to prevent race conditions.
  cancelInFlightNavigation();

  const controller = new AbortController();
  inFlightNavigation = { controller, pathname };

  let payload: RenderPayload | undefined;
  try {
    payload = await fetchPayload(pathname, search, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) return false; // superseded by a newer nav
    throw err;
  }

  // If a newer navigation started while we were fetching, bail out.
  if (inFlightNavigation && inFlightNavigation.controller !== controller) {
    if (controller.signal.aborted) return false;
  }
  inFlightNavigation = null;

  if (!payload) return false;

  const app = document.getElementById("app");
  if (!app) return false;

  // Save scroll position in the current history entry before navigating.
  if (push) {
    history.replaceState(
      { n: location.pathname, scroll: window.scrollY },
      "",
      location.href,
    );
  }

  const current = new URL(location.href);
  const doSwap = () => {
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
    const temp = document.createElement("template");
    temp.innerHTML = payload.body;
    hoistStyles(temp.content as unknown as HTMLElement);

    // Inject the remaining body (styles already moved to <head>)
    app.innerHTML = temp.innerHTML;
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

    // Announce the navigation to screen readers.
    announceNavigation(pathname);

    // Move focus to the main content for keyboard/screen reader users.
    // Only on push (forward navigation), not on back/forward (popstate).
    if (push) moveFocusToContent();

    document.dispatchEvent(new CustomEvent("nix-js:rendered"));
  };

  // Use View Transitions when available and the user hasn't opted out.
  const useTransition = supportsViewTransitions() && !prefersReducedMotion();
  if (useTransition) {
    (document as any).startViewTransition(() => doSwap());
  } else {
    doSwap();
  }

  return true;
}

/**
 * Replaces all `<head>` tags marked with `data-nix-js-head` with the new ones
 * from the server payload. Also updates `document.title` when a title tag is
 * present in the new head.
 */
function mergeHead(head: string | undefined, fallbackTitle: string | undefined): void {
  // Remove existing managed tags.
  const existing = document.querySelectorAll("[data-nix-js-head]");
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

    // Interaction prefetch (default): hover or focus.
    const onInteract = () => {
      const info = linkInfo(link);
      if (info) void prefetch(info.path, info.search);
    };
    link.addEventListener("pointerenter", onInteract, { once: true });
    link.addEventListener("focus", onInteract, { once: true });

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
  document.addEventListener("nix-js:rendered", observeLinks);
}

// --- Router bootstrap ---

export function startClientRouter(): void {
  // Static builds emit this marker, so the client never probes the render
  // endpoint (zero 404s on fully static deployments). The meta lives in the
  // initial HTML head and persists across SPA navigations.
  const endpointMeta = document.querySelector<HTMLMetaElement>(
    'meta[name="nix-js:render-endpoint"]',
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

  setupLinkPrefetch();
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
}

