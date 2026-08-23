// --- Adapter capabilities contract (§8.5) ---
//
// Every runtime host (Node CLI, Vite dev, Node/Bun adapters, Vercel, Netlify)
// declares an explicit `AdapterCapabilities` object. The framework uses it to
// decide which features are safe to enable: streaming, filesystem access,
// runtime image transforms, background work, body size limits, ISR persistence.
//
// Invalid or incompatible capability combinations fail fast during build.

export type FilesystemCapability = "none" | "readonly" | "persistent" | "ephemeral";

export interface AdapterCapabilities {
  /** Whether the host supports streaming responses (ReadableStream bodies). */
  streaming: boolean;
  /** Filesystem access model of the host. */
  filesystem: FilesystemCapability;
  /** Whether the host can run image transforms at request time. */
  imageRuntime: boolean;
  /** Whether the host allows background work after the response completes. */
  backgroundWork: boolean;
  /** Maximum request body size in bytes accepted by the host (if any). */
  maxBodySize?: number;
}

export interface CapabilityOptions {
  streaming?: boolean;
  filesystem?: FilesystemCapability;
  imageRuntime?: boolean;
  backgroundWork?: boolean;
  maxBodySize?: number;
}

/** Default capabilities for a full-featured long-lived Node/Bun process. */
export const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  streaming: true,
  filesystem: "persistent",
  imageRuntime: true,
  backgroundWork: true,
};

/** Default capabilities for a stateless serverless function (Vercel/Netlify). */
export const SERVERLESS_CAPABILITIES: AdapterCapabilities = {
  streaming: true,
  filesystem: "ephemeral",
  imageRuntime: false,
  backgroundWork: false,
  maxBodySize: 1_048_576,
};

/** Default capabilities for an edge runtime (read-only filesystem). */
export const EDGE_CAPABILITIES: AdapterCapabilities = {
  streaming: true,
  filesystem: "readonly",
  imageRuntime: false,
  backgroundWork: false,
  maxBodySize: 1_048_576,
};

export function createCapabilities(options: CapabilityOptions = {}): AdapterCapabilities {
  return {
    ...DEFAULT_CAPABILITIES,
    ...options,
  };
}

/** True when the host supports streaming responses (streaming !== false). */
export function supportsStreaming(capabilities: Pick<AdapterCapabilities, "streaming"> = { streaming: true }): boolean {
  return capabilities.streaming !== false;
}

/** True when the host can write to persistent storage (for ISR/cache/image writes). */
export function supportsPersistentStorage(capabilities: Pick<AdapterCapabilities, "filesystem">): boolean {
  return capabilities.filesystem === "persistent";
}

/** True when the host exposes a writable filesystem at build/runtime. */
export function supportsWritableFilesystem(capabilities: Pick<AdapterCapabilities, "filesystem">): boolean {
  return capabilities.filesystem === "persistent" || capabilities.filesystem === "ephemeral";
}

export interface CapabilityDiagnostics {
  ok: boolean;
  problems: string[];
}

/**
 * Validates a capability declaration and reports incompatible combinations.
 * Used by the build pipeline so invalid hosts fail at build time instead of
 * producing a broken runtime.
 */
export function validateCapabilities(
  capabilities: AdapterCapabilities,
  features: { isr?: boolean; images?: boolean; streaming?: boolean } = {},
): CapabilityDiagnostics {
  const problems: string[] = [];

  if (features.isr && !supportsPersistentStorage(capabilities)) {
    problems.push(
      `ISR requires a persistent filesystem; the host declares filesystem="${capabilities.filesystem}".`,
    );
  }
  if (features.images && capabilities.imageRuntime === false && capabilities.filesystem === "none") {
    problems.push(
      "On-demand image transforms require either imageRuntime=true or a readable filesystem; the host has neither.",
    );
  }
  if (features.streaming && capabilities.streaming === false) {
    problems.push("Streaming was requested but the host declares streaming=false.");
  }

  return { ok: problems.length === 0, problems };
}
