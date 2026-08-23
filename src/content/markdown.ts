// --- Markdown → HTML renderer (optional `marked` peer dependency) ---
//
// Markdown rendering is delegated to `marked` when available. If `marked` is
// not installed, a clear error is thrown with installation instructions.
//
// The resulting HTML is treated as trusted author content (same model as
// Astro). If you render user-generated Markdown, sanitize it yourself before
// passing it to the renderer.

type MarkedModule = { marked: (src: string) => string };
let markedLoader: (() => Promise<MarkedModule>) | null | undefined;

/**
 * Lazily loads `marked` from the user's project. We use a dynamic import so
 * the kit itself has no hard dependency on `marked`.
 */
async function loadMarked(): Promise<MarkedModule> {
  if (markedLoader === null) {
    throw new Error(
      "[nix-js-kit] Markdown rendering requires the `marked` package. Install it with:\n" +
      "  npm install marked\n" +
      "  # or\n" +
      "  bun add marked",
    );
  }
  if (markedLoader) return await markedLoader();

  // Try to import `marked` from the user's project.
  try {
    // @ts-ignore — `marked` is an optional peer dependency.
    const mod = (await import("marked")) as unknown as { marked?: (src: string) => string; default?: (src: string) => string };
    const fn = (typeof mod.marked === "function" ? mod.marked : mod.default) as (src: string) => string;
    const wrapped = { marked: fn };
    markedLoader = async () => wrapped;
    return wrapped;
  } catch {
    markedLoader = null;
    throw new Error(
      "[nix-js-kit] Markdown rendering requires the `marked` package. Install it with:\n" +
      "  npm install marked\n" +
      "  # or\n" +
      "  bun add marked",
    );
  }
}

/**
 * Renders a Markdown string to HTML using `marked`.
 *
 * @throws If `marked` is not installed.
 */
export async function renderMarkdown(source: string): Promise<string> {
  const { marked } = await loadMarked();
  return marked(source) as string;
}
