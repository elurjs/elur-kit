import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEntrySource } from "../src/island/generate-entry.ts";

// Fix #1: Route-level code-splitting via dynamic import()
// The generated client entry must use `import()` (dynamic) for each island,
// not static `import`, so Vite emits separate chunks per island.

describe("Fix #1: Client router code-splitting", () => {
  it("generates dynamic import() for each island (not static import)", () => {
    const source = buildEntrySource(
      [
        { name: "Counter", filePath: "/app/islands/Counter.ts" },
        { name: "TodoList", filePath: "/app/islands/TodoList.ts" },
      ],
      "/.elur/entry-client.ts",
    );

    // Must contain `import(` (dynamic) — not `import Counter from` (static).
    assert.ok(
      source.includes("load: () => import("),
      "entry source must use dynamic import() for lazy loading",
    );
    assert.ok(
      !source.match(/import\s+\w+\s+from\s+["']/),
      "entry source must not use static import for island modules",
    );
  });

  it("wraps each island in a { load } discriminated lazy loader", () => {
    const source = buildEntrySource(
      [{ name: "Hero", filePath: "/app/islands/Hero.ts" }],
      "/.elur/entry-client.ts",
    );

    // The registry entry must be `{ load: () => import(...).then(m => m.default) }`
    assert.ok(
      source.includes('"Hero": { load: () => import('),
      "island must be wrapped in { load } lazy loader",
    );
    assert.ok(
      source.includes(".then(m => m.default)"),
      "lazy loader must extract default export",
    );
  });

  it("generates separate import specifiers per island (separate chunks)", () => {
    const source = buildEntrySource(
      [
        { name: "A", filePath: "/app/islands/A.ts" },
        { name: "B", filePath: "/app/islands/B.ts" },
        { name: "C", filePath: "/app/islands/C.ts" },
      ],
      "/.elur/entry-client.ts",
    );

    // Each island must have its own import specifier.
    const importMatches = source.match(/import\(["'][^"']+["']\)/g) ?? [];
    assert.equal(importMatches.length, 3, "each island must have its own dynamic import");
  });
});
