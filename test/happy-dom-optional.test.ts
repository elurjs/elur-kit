import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

// happy-dom is NOT a runtime/peer dependency of the kit: the SSR runtime uses
// the core's DOM-free `renderToString` (`@elurjs/core/server`), so the legacy
// happy-dom fallback was removed and no `src/` file imports it.
//
// happy-dom is allowed ONLY as a `devDependency`, exclusively to provide a DOM
// environment for the client-side test suites (`island.test.ts`,
// `client-router.test.ts`, ...). It must never ship in the published bundle:
//   - it is absent from `dependencies`, `peerDependencies` and
//     `peerDependenciesMeta`;
//   - it is not imported by any `src/` module (only by `test/`);
//   - it is not referenced by either vite build config (`vite.lib.config.ts` /
//     `vite.cli.config.ts`), so it cannot be pulled into `dist/`.
//
// These tests guard against accidental re-introduction as a runtime dependency
// and document the test-only intent.

describe("happy-dom is a test-only dependency", () => {
  it("happy-dom is NOT in dependencies (not a runtime dep)", () => {
    assert.ok(
      !pkg.dependencies || !("happy-dom" in pkg.dependencies),
      "happy-dom must not be in dependencies (it's not a runtime dep)",
    );
  });

  it("happy-dom is NOT in peerDependencies", () => {
    assert.ok(
      !pkg.peerDependencies || !("happy-dom" in pkg.peerDependencies),
      "happy-dom must not be in peerDependencies",
    );
  });

  it("happy-dom is NOT in peerDependenciesMeta", () => {
    assert.ok(
      !pkg.peerDependenciesMeta || !("happy-dom" in pkg.peerDependenciesMeta),
      "happy-dom must not be in peerDependenciesMeta",
    );
  });

  it("happy-dom IS in devDependencies (test-only DOM environment)", () => {
    assert.ok(
      pkg.devDependencies && "happy-dom" in pkg.devDependencies,
      "happy-dom should be in devDependencies (used only by the test suite)",
    );
  });

  it("happy-dom is NOT in the published files (dist/lib only)", () => {
    assert.ok(
      Array.isArray(pkg.files) && !pkg.files.some((f) => /node_modules|happy-dom/.test(f)),
      "happy-dom must not be listed in `files` (it is never shipped)",
    );
  });
});
