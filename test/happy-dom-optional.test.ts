import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

// happy-dom is no longer a dependency of the kit: the SSR runtime uses the
// core's DOM-free `renderToString` (`@elurjs/core/server`), so the legacy
// happy-dom fallback was removed. This test guards against accidental
// re-introduction as a runtime/peer dependency.

describe("happy-dom is not a kit dependency", () => {
  it("happy-dom is NOT in dependencies", () => {
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
});
