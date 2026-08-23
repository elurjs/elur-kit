// --- @deijose/nix-js-kit/runtime — unified Web runtime entry ---
//
// Public surface for the unified Web handler, request context and static file
// serving. Every adapter and CLI runtime path imports from here so behavior
// stays identical across Node, Bun, Vercel, Netlify and Vite dev.

export {
  RequestContext,
  type RequestContextOptions,
  type RouteTable,
  type CookieJar,
  type ResponseCookieJar,
  type ResponseState,
  type CookieOptions,
  htmlResponse,
  jsonResponse,
  textResponse,
  notFound,
  methodNotAllowed,
  serverError,
  guessContentType,
  serveStaticFile,
} from "./context.js";

export {
  createWebHandler,
  type WebHandlerOptions,
  type WebHandlerRouteTable,
  type WebHandlerActionRegistry,
  type CreateWebHandlerResult,
} from "./handler.js";

export { resolveStaticFile } from "./static.js";
export { incomingMessageToRequest } from "./node-http.js";
export {
  buildSecurityHeaders,
  applySecurityHeaders,
  DEFAULT_SECURITY_HEADERS,
} from "./security-headers.js";
export {
  DEFAULT_CAPABILITIES,
  SERVERLESS_CAPABILITIES,
  EDGE_CAPABILITIES,
  createCapabilities,
  supportsStreaming,
  supportsPersistentStorage,
  supportsWritableFilesystem,
  validateCapabilities,
  type AdapterCapabilities,
  type FilesystemCapability,
  type CapabilityOptions,
  type CapabilityDiagnostics,
} from "./capabilities.js";
