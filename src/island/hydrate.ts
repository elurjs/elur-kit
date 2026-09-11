import type { ElurTemplate } from "@elurjs/core";
import { hydrate as hydrateTemplate } from "@elurjs/core/hydrate";
import { ISLAND_MARKER_ATTR, PERSIST_ATTR, type IslandDirective } from "./island.js";

// --- Client-side island hydration ---

// Keep track of every active island dispose keyed by its marker element so
// `cleanupHydratedIslands({ except })` can spare islands inside persisted
// nodes (`data-elur-persist`) that the router moves — not recreates — across
// SPA navigations.
const _islandDisposes = new Map<HTMLElement, () => void>();
const _islandSchedules = new Map<HTMLElement, () => void>();

// Finds [data-elur-island] markers in the current document and mounts the
// corresponding interactive components over them. This runs in the browser.

export type IslandComponent<TProps = unknown> = (props: TProps) => ElurTemplate | null | false | undefined;

// Re-exported from island.ts so the client entry and the server helper share a
// single source of truth for the directive union (now includes "only").
export type { IslandDirective } from "./island.js";

/** Lazy island loader in a discriminated form (no probe required to detect). */
export interface IslandLoader<TProps = unknown> {
  load: () => Promise<IslandComponent<TProps>>;
}

/**
 * Island registry entry. Two unambiguous shapes:
 *   - `IslandComponent` (eager component function).
 *   - `IslandLoader` `{ load }` (lazy, code-split loader).
 *
 * Legacy async loader functions are also accepted for backwards compatibility
 * and detected *without invoking them* (via the `AsyncFunction` tag), so no
 * side effects or duplicate signal creation happen during detection.
 */
export type IslandRegistryEntry<TProps = unknown> =
  | IslandComponent<TProps>
  | IslandLoader<TProps>
  | (() => Promise<IslandComponent<TProps>>);

export type IslandRegistry = Record<string, IslandRegistryEntry<any>>;

/**
 * Wraps a lazy island loader in the discriminated `{ load }` form.
 */
export function lazyIsland<TProps = unknown>(
  loader: () => Promise<IslandComponent<TProps>>,
): IslandLoader<TProps> {
  return { load: loader };
}

function isIslandLoader(value: unknown): value is IslandLoader {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { load?: unknown }).load === "function"
  );
}

function isAsyncFunction(value: unknown): boolean {
  if (typeof value !== "function") return false;
  const ctor = (value as { constructor?: { name?: string } }).constructor;
  return ctor?.name === "AsyncFunction" || (value as { [Symbol.toStringTag]?: string })[Symbol.toStringTag] === "AsyncFunction";
}

interface IslandMarker {
  el: HTMLElement;
  name: string;
  directive: IslandDirective;
  props: unknown;
  propsError?: unknown;
}

function collectMarkers(): IslandMarker[] {
  const elements = Array.from(
    document.querySelectorAll<HTMLElement>(`[${ISLAND_MARKER_ATTR}]`),
  );
  return elements.map((el) => {
    const marker: IslandMarker = {
      el,
      name: el.dataset.elurIsland ?? "",
      directive: (el.dataset.directive as IslandDirective) ?? "load",
      props: null,
    };
    if (el.dataset.props) {
      try {
        marker.props = JSON.parse(el.dataset.props);
      } catch (error) {
        marker.propsError = error;
      }
    }
    return marker;
  });
}

async function hydrate(marker: IslandMarker, registry: IslandRegistry): Promise<void> {
  try {
    if (marker.propsError) {
      reportIslandError(marker, marker.propsError);
      return;
    }

    const entry = registry[marker.name];
    if (!entry) {
      console.warn(
        `[elur-kit] No island registered for "${marker.name}". ` +
        `Check that src/islands/${marker.name}.ts exists and rebuild so the client entry is regenerated.`,
      );
      return;
    }

    // Resolve the component without probing: a `{ load }` loader or an async
    // function is lazy (awaited for the module/component); anything else is an
    // eager component called directly with the island props. Detection never
    // invokes the component with undefined props, so no side effects or
    // duplicate signal creation occur during resolution. Eager components
    // hydrate synchronously; lazy loaders hydrate once the module resolves.
    let Component: IslandComponent | undefined;
    if (isIslandLoader(entry)) {
      const mod = (await (entry as IslandLoader).load()) as IslandComponent | { default?: unknown };
      Component = typeof mod === "function" ? (mod as IslandComponent) : (mod as { default?: unknown }).default as IslandComponent | undefined;
    } else if (typeof entry === "function") {
      if (isAsyncFunction(entry)) {
        const mod = (await (entry as () => Promise<unknown>)()) as IslandComponent | { default?: unknown };
        Component = typeof mod === "function" ? (mod as IslandComponent) : (mod as { default?: unknown }).default as IslandComponent | undefined;
      } else {
        Component = entry as IslandComponent;
      }
    }

    if (typeof Component !== "function") {
      console.warn(
        `[elur-kit] Island "${marker.name}" did not resolve to a component function. ` +
        `Check that the island module exports the component as default export.`,
      );
      return;
    }

    const template = Component(marker.props);
    if (template === null || template === false || template === undefined) return;
    const prevDispose = (marker.el as any).__elur_js_island_dispose;
    if (typeof prevDispose === "function") prevDispose();

    // Islands with directive "only" or options.ssr:false have no SSR-rendered
    // DOM inside the marker — only fallback HTML or nothing. hydrateTemplate
    // assumes the SSR DOM is already present and walks it for hydration markers
    // (<!--elur-N-->, data-elur-e-*). When there's nothing to walk, it silently
    // does nothing (no contexts to match → empty loop → no mount). So we detect
    // the absence of hydration markers and do a fresh _render mount instead.
    const hasSSRMarkers = marker.el.innerHTML.includes("<!--elur-");
    const handle = hasSSRMarkers
      ? hydrateTemplate(template, marker.el, { mismatch: "warn-remount" })
      : freshMount(template, marker.el);

    const wrappedDispose = () => {
      handle.unmount();
      if (_islandDisposes.get(marker.el) === wrappedDispose) {
        _islandDisposes.delete(marker.el);
      }
      delete (marker.el as any).__elur_js_island_dispose;
    };
    (marker.el as any).__elur_js_island_dispose = wrappedDispose;
    _islandDisposes.set(marker.el, wrappedDispose);
  } catch (error) {
    reportIslandError(marker, error);
  }
}

function reportIslandError(marker: IslandMarker, error: unknown): void {
  console.error(
    `[elur-kit] Failed to hydrate island "${marker.name}" — the server-rendered HTML was left as-is. Cause:`,
    error,
  );
  const EventConstructor = marker.el.ownerDocument.defaultView?.CustomEvent;
  if (EventConstructor) {
    marker.el.dispatchEvent(new EventConstructor("elur:island-error", {
      bubbles: true,
      detail: { name: marker.name, error },
    }));
  }
}

/**
 * Mounts a template fresh into a container (no hydration).
 * Used for islands with no SSR DOM (directive "only" or ssr:false) where
 * hydrateTemplate can't work — there's nothing to hydrate against.
 */
function freshMount(template: ElurTemplate, container: Element): { unmount: () => void } {
  container.replaceChildren();
  const dispose = template._render(container, null);
  return { unmount: dispose };
}

/**
 * Options for {@link cleanupHydratedIslands}.
 */
export interface CleanupIslandsOptions {
  /**
   * Root elements whose islands must NOT be disposed — used by the SPA router
   * to keep the live state of islands inside `data-elur-persist` nodes that
   * are moved (not re-rendered) into the new page. The router passes them via
   * the `elur:before-render` event detail (`detail.persisted`).
   */
  except?: Iterable<Element>;
}

/**
 * Dispose all currently hydrated islands. Runs on the `elur:before-render`
 * event — dispatched by the client router BEFORE it swaps the page body — so
 * effects are cleaned up while their DOM is still attached, and islands inside
 * `except` roots keep running untouched.
 *
 * Hosts that only dispatch the legacy `elur:rendered` event keep working: the
 * generated entry runs this cleanup on `elur:rendered` as a compat fallback
 * when no `elur:before-render` preceded it.
 */
export function cleanupHydratedIslands(options?: CleanupIslandsOptions): void {
  const except = options?.except ? Array.from(options.except) : undefined;
  const kept = (el: Element): boolean =>
    except?.some((root) => root === el || root.contains(el)) ?? false;
  for (const [el, cancel] of _islandSchedules) {
    if (kept(el)) continue;
    _islandSchedules.delete(el);
    cancel();
  }
  for (const [el, dispose] of _islandDisposes) {
    if (kept(el)) continue;
    dispose();
  }
}

export function hydrateIslands(registry: IslandRegistry): void {
  if (typeof window === "undefined") return;

  const markers = collectMarkers();

  for (const marker of markers) {
    const el = marker.el as HTMLElement & { __elur_js_island_dispose?: () => void };
    if (typeof el.__elur_js_island_dispose === "function") {
      // Already hydrated. Islands inside `data-elur-persist` nodes keep their
      // live instance across navigations (persist wins over prop changes);
      // anything else — e.g. a stale marker after a non-router re-render — is
      // disposed and re-hydrated fresh.
      if (el.closest(`[${PERSIST_ATTR}]`)) continue;
      el.__elur_js_island_dispose();
    }
    // Skip markers that already have a pending hydration schedule — e.g. a
    // "visible" island inside a persisted node keeps its observer.
    if (_islandSchedules.has(marker.el)) continue;

    if (marker.directive === "load" || marker.directive === "only") {
      // "only" is client-only (no SSR) but hydrates immediately on the
      // client, just like "load" — the difference is purely server-side.
      void hydrate(marker, registry);
      continue;
    }

    if (marker.directive === "idle") {
      let cancel = () => { };
      if ("requestIdleCallback" in window) {
        const id = window.requestIdleCallback(() => {
          _islandSchedules.delete(marker.el);
          void hydrate(marker, registry);
        });
        cancel = () => window.cancelIdleCallback(id);
      } else {
        const id = globalThis.setTimeout(() => {
          _islandSchedules.delete(marker.el);
          void hydrate(marker, registry);
        }, 0);
        cancel = () => globalThis.clearTimeout(id);
      }
      _islandSchedules.set(marker.el, cancel);
      continue;
    }

    if (marker.directive === "visible") {
      if ("IntersectionObserver" in window) {
        let cancel = () => { };
        const observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                _islandSchedules.delete(marker.el);
                observer.disconnect();
                void hydrate(marker, registry);
              }
            }
          },
          { rootMargin: "0px", threshold: 0 },
        );
        cancel = () => observer.disconnect();
        _islandSchedules.set(marker.el, cancel);
        observer.observe(marker.el);
      } else {
        void hydrate(marker, registry);
      }
    }
  }
}
