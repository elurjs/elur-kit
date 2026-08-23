// --- Integration hooks for optional packages (plan §11.6) ---
//
// These hooks allow optional packages (nix-i18n, nix-js-auth, nix-query,
// nix-js-testing) to integrate with the Kit runtime without being a
// dependency. The Kit calls these hooks at well-defined points; integrations
// register themselves via `registerIntegration()`.
//
// Design:
//   - Hooks are typed interfaces, not concrete implementations.
//   - The Kit never imports optional packages directly.
//   - Integrations register via the public API.
//   - Missing integrations are silently skipped (no error).

import type { NixKitIntegration } from "./index.js";

// i18n hooks (nix-i18n)

export interface I18nIntegration {
  /** Extracts the locale from a request (e.g. from URL, cookie, Accept-Language). */
  getLocale(request: Request): string | Promise<string>;
  /** Returns hreflang alternates for a given URL and locale. */
  getAlternates(url: URL, locale: string): Array<{ hreflang: string; href: string }>;
  /** Translates a key for a given locale. */
  translate(key: string, locale: string, params?: Record<string, unknown>): string;
}

// Auth hooks (nix-js-auth)

export interface AuthIntegration {
  /** Extracts the user/session from a request and populates locals. */
  getSession(request: Request): Promise<{ user?: unknown; session?: unknown } | null>;
  /** Seeds SSR data with auth state for client hydration. */
  seedSSR(locals: Record<string, unknown>): Record<string, unknown>;
}

// Query hooks (nix-query)

export interface QueryIntegration {
  /** Dehydrates query cache for SSR serialization. */
  dehydrate(): Record<string, unknown>;
  /** Rehydrates query cache on the client from SSR data. */
  rehydrate(data: Record<string, unknown>): void;
  /** Invalidates queries by tags/keys after an action. */
  invalidate(tags: readonly string[], keys?: readonly string[]): void | Promise<void>;
}

// Testing hooks (nix-js-testing)

export interface TestingIntegration {
  /** Creates a test request fixture. */
  createRequest(method: string, path: string, options?: RequestInit): Request;
  /** Creates a render fixture for a given route. */
  createRenderFixture(routePath: string, params?: Record<string, string>): unknown;
  /** Resets test state between tests. */
  reset(): void;
}

// Registry

interface IntegrationRegistry {
  i18n?: I18nIntegration;
  auth?: AuthIntegration;
  query?: QueryIntegration;
  testing?: TestingIntegration;
  custom: NixKitIntegration[];
}

const registry: IntegrationRegistry = { custom: [] };

/**
 * Registers an integration. Optional packages call this on import.
 * The Kit never imports optional packages — they register themselves.
 */
export function registerIntegration(
  type: "i18n",
  integration: I18nIntegration,
): void;
export function registerIntegration(
  type: "auth",
  integration: AuthIntegration,
): void;
export function registerIntegration(
  type: "query",
  integration: QueryIntegration,
): void;
export function registerIntegration(
  type: "testing",
  integration: TestingIntegration,
): void;
export function registerIntegration(
  type: "custom",
  integration: NixKitIntegration,
): void;
export function registerIntegration(
  type: keyof IntegrationRegistry,
  integration: unknown,
): void {
  if (type === "custom") {
    registry.custom.push(integration as NixKitIntegration);
  } else {
    (registry as unknown as Record<string, unknown>)[type] = integration;
  }
}

/** Gets the registered i18n integration, if any. */
export function getI18nIntegration(): I18nIntegration | undefined {
  return registry.i18n;
}

/** Gets the registered auth integration, if any. */
export function getAuthIntegration(): AuthIntegration | undefined {
  return registry.auth;
}

/** Gets the registered query integration, if any. */
export function getQueryIntegration(): QueryIntegration | undefined {
  return registry.query;
}

/** Gets the registered testing integration, if any. */
export function getTestingIntegration(): TestingIntegration | undefined {
  return registry.testing;
}

/** Gets all registered custom integrations. */
export function getCustomIntegrations(): readonly NixKitIntegration[] {
  return registry.custom;
}

/** Clears all registered integrations. Used in tests. */
export function clearIntegrations(): void {
  registry.i18n = undefined;
  registry.auth = undefined;
  registry.query = undefined;
  registry.testing = undefined;
  registry.custom = [];
}
