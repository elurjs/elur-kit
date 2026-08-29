// --- SSR flag utility ---
//
// `@elurjs/core` does not export `_setSSR`/`_isSSR`. The reactivity state lives
// on `globalThis[Symbol.for("@elurjs/core/reactivity-state")]` and the kit owns
// the `ssr` boolean on it: `renderToString` sets it to `true` while server
// rendering so `isSSR()` reflects the current render mode for user code
// (environment reads, client-only guards, ...).
//
// This module manipulates that flag directly so the kit does not depend on
// private exports that may or may not be present in a given elur release.

const STATE_KEY = Symbol.for("@elurjs/core/reactivity-state");

type ReactivityState = { ssr?: boolean };

function getState(): ReactivityState | undefined {
  return (globalThis as Record<symbol, unknown>)[STATE_KEY] as
    | ReactivityState
    | undefined;
}

/** Sets the SSR flag on the Elur reactivity state. No-op if state is absent. */
export function setSSR(value: boolean): void {
  const state = getState();
  if (state) state.ssr = value;
}

/** Reads the SSR flag from the Elur reactivity state. Defaults to false. */
export function isSSR(): boolean {
  return getState()?.ssr ?? false;
}
