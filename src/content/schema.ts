// --- Schema validation (optional `zod` peer dependency) ---
//
// Collections can define a schema for their frontmatter. When `zod` is
// installed, schemas are validated at parse time and errors include the file
// path and field. When `zod` is not installed, schemas are ignored (the data
// is returned as-is) so the content layer still works without validation.

export interface SchemaValidator {
  (data: unknown, filePath: string): Record<string, unknown>;
}

let zodLoader: (() => Promise<any>) | null | undefined;

async function loadZod(): Promise<any | null> {
  if (zodLoader === null) return null;
  if (zodLoader) return zodLoader();
  try {
    // @ts-ignore — `zod` is an optional peer dependency.
    const mod = await import("zod");
    zodLoader = async () => mod;
    return mod;
  } catch {
    zodLoader = null;
    return null;
  }
}

/**
 * Creates a validator function from a schema object. If the schema is a zod
 * schema (has a `.parse` method), it is used directly. If `zod` is not
 * installed but a schema is provided, validation is skipped with a warning.
 */
export function createValidator(schema: unknown): SchemaValidator | undefined {
  if (!schema) return undefined;

  // Check if it's a zod schema (duck-typing).
  if (schema && typeof schema === "object" && typeof (schema as any).parse === "function") {
    return (data: unknown, filePath: string) => {
      try {
        return (schema as any).parse(data);
      } catch (err: any) {
        const issues = err?.issues ?? err?.errors ?? [];
        const details = Array.isArray(issues)
          ? issues.map((i: any) => `  - ${i.path?.join(".") ?? "(root)"}: ${i.message}`).join("\n")
          : String(err);
        throw new Error(
          `[nix-js-kit] Schema validation failed for "${filePath}":\n${details}`,
        );
      }
    };
  }

  // Plain function validator.
  if (typeof schema === "function") {
    return (data: unknown, filePath: string) => {
      try {
        return (schema as Function)(data);
      } catch (err: any) {
        throw new Error(`[nix-js-kit] Schema validation failed for "${filePath}": ${err?.message ?? err}`);
      }
    };
  }

  return undefined;
}

/**
 * Ensures `zod` is available and re-exports it. Used by `defineCollection`
 * consumers who want to write `z.object(...)` schemas.
 */
export async function getZod(): Promise<any> {
  const zod = await loadZod();
  if (!zod) {
    throw new Error(
      "[nix-js-kit] Schema validation requires the `zod` package. Install it with:\n" +
      "  npm install zod\n" +
      "  # or\n" +
      "  bun add zod",
    );
  }
  return zod;
}
