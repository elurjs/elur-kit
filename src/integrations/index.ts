export interface ElurKitIntegrationContext {
  root: string;
  command: "dev" | "build" | "preview" | "start" | "check" | "routes" | "doctor";
}

export interface ElurKitIntegration {
  name: string;
  config?(config: Record<string, unknown>, context: ElurKitIntegrationContext): void | Promise<void>;
  routes?(manifest: unknown, context: ElurKitIntegrationContext): void | Promise<void>;
  request?(request: Request, context: ElurKitIntegrationContext): void | Response | Promise<void | Response>;
  render?(result: { html: string }, context: ElurKitIntegrationContext): void | Promise<void>;
  build?(result: unknown, context: ElurKitIntegrationContext): void | Promise<void>;
  clientEntry?(source: string, context: ElurKitIntegrationContext): string | void | Promise<string | void>;
  error?(error: unknown, context: ElurKitIntegrationContext): void | Promise<void>;
}

export async function runIntegrationHook<K extends keyof Omit<ElurKitIntegration, "name">>(
  integrations: readonly ElurKitIntegration[],
  hook: K,
  args: Parameters<NonNullable<ElurKitIntegration[K]>>,
): Promise<void> {
  for (const integration of integrations) {
    const handler = integration[hook];
    if (typeof handler === "function") await (handler as (...values: unknown[]) => unknown)(...args);
  }
}

// Typed integration hooks for optional packages (plan §11.6).
export {
  type I18nIntegration,
  type AuthIntegration,
  type QueryIntegration,
  type TestingIntegration,
  registerIntegration,
  getI18nIntegration,
  getAuthIntegration,
  getQueryIntegration,
  getTestingIntegration,
  getCustomIntegrations,
  clearIntegrations,
} from "./hooks.js";
