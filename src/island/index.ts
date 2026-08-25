// --- @deijose/nix-js-kit/island ---
//
// Client-only entry point. Import `hydrateIslands` from here in your entry-client
// so the client bundle does not pull in server-only code (route scanner, build
// orchestrator, happy-dom, etc.).
//
// Server-side pages should import `island()` from the main package instead.

export { hydrateIslands, cleanupHydratedIslands, lazyIsland, type IslandRegistry, type IslandLoader, type IslandRegistryEntry } from "./hydrate.js";
export type { IslandComponent, IslandDirective, IslandOptions } from "./island.js";
