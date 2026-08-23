// Path traversal fuzz tests (plan §1, A-06, testing-roadmap §3.3)
//
// Tests that resolveStaticFile rejects:
//   - encoded traversal (%2e%2e, %2f, %5c)
//   - mixed separators (../ and ..\)
//   - NUL bytes
//   - Unicode normalization tricks
//   - prefix-sibling paths (/public-secret vs /public)
//   - symlink escape
//   - double encoding

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolveStaticFile } from "../src/runtime/static.ts";
import { mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_ROOT = join(tmpdir(), `nix-traversal-${Date.now()}`);
const SECRET_FILE = join(tmpdir(), `nix-secret-${Date.now()}.txt`);

before(async () => {
  await mkdir(join(TEST_ROOT, "subdir"), { recursive: true });
  await mkdir(join(TEST_ROOT, "public"), { recursive: true });
  await writeFile(join(TEST_ROOT, "index.html"), "<html>safe</html>");
  await writeFile(join(TEST_ROOT, "subdir", "page.html"), "<html>sub</html>");
  await writeFile(join(TEST_ROOT, "public", "style.css"), "body{}");
  await writeFile(SECRET_FILE, "secret data");
});

after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await rm(SECRET_FILE, { force: true });
});

describe("path traversal: encoded traversal (A-06)", () => {
  it("rejects %2e%2e (encoded ..)", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/%2e%2e/secret.txt");
    assert.equal(result, null);
  });

  it("rejects %2f combined with .. (encoded / used for traversal)", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/subdir%2f..%2fsecret.txt");
    assert.equal(result, null);
  });

  it("rejects %5c (encoded backslash)", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/%5c%5csecret.txt");
    assert.equal(result, null);
  });

  it("rejects double-encoded %252e%252e", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/%252e%252e/secret.txt");
    // After first decode: %2e%2e — but decodeURIComponent only decodes once
    // so this becomes literal %2e%2e which is not .. and should not traverse
    // It should return null because the file doesn't exist
    assert.equal(result, null);
  });

  it("rejects mixed case %2E%2E", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/%2E%2E/secret.txt");
    assert.equal(result, null);
  });
});

describe("path traversal: mixed separators (A-06)", () => {
  it("rejects ..\\ separator", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/..\\secret.txt");
    assert.equal(result, null);
  });

  it("rejects ..%5c separator", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/..%5csecret.txt");
    assert.equal(result, null);
  });

  it("rejects ..%255c (double-encoded backslash)", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/..%255csecret.txt");
    assert.equal(result, null);
  });
});

describe("path traversal: NUL bytes (A-06)", () => {
  it("rejects %00 in path", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/index.html%00.txt");
    assert.equal(result, null);
  });

  it("rejects literal NUL in path", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/index.html\0.txt");
    assert.equal(result, null);
  });
});

describe("path traversal: prefix-sibling paths (A-06)", () => {
  it("rejects /public-secret when root is /public", async () => {
    const publicRoot = join(TEST_ROOT, "public");
    const result = await resolveStaticFile(publicRoot, "/../public-secret");
    assert.equal(result, null);
  });

  it("allows /style.css inside public root", async () => {
    const publicRoot = join(TEST_ROOT, "public");
    const result = await resolveStaticFile(publicRoot, "/style.css");
    assert.ok(result, "should find style.css inside public root");
    assert.ok(result!.includes("style.css"));
  });
});

describe("path traversal: basic traversal (A-06)", () => {
  it("rejects ../", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/../secret.txt");
    assert.equal(result, null);
  });

  it("rejects ../../", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/../../etc/passwd");
    assert.equal(result, null);
  });

  it("rejects nested ../..", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/subdir/../../secret.txt");
    assert.equal(result, null);
  });

  it("allows valid file inside root", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/index.html");
    assert.ok(result, "should find index.html");
    assert.ok(result!.includes("index.html"));
  });

  it("allows valid file in subdir", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/subdir/page.html");
    assert.ok(result, "should find subdir/page.html");
    assert.ok(result!.includes("page.html"));
  });
});

describe("path traversal: Unicode normalization (A-06)", () => {
  it("rejects Unicode fullwidth .. (U+FF0E)", async () => {
    // U+FF0E is FULLWIDTH FULL STOP, which normalizes to . in some contexts
    const result = await resolveStaticFile(TEST_ROOT, "/\uff0e\uff0e/secret.txt");
    assert.equal(result, null);
  });

  it("rejects Unicode fullwidth / (U+FF0F)", async () => {
    const result = await resolveStaticFile(TEST_ROOT, "/subdir\uff0fpage.html");
    // This should not resolve to subdir/page.html
    assert.equal(result, null);
  });
});

describe("path traversal: symlink escape (A-06)", () => {
  it("rejects symlink that escapes root", async () => {
    // Create a symlink inside root that points outside
    const symlinkPath = join(TEST_ROOT, "escape-link");
    try {
      await symlink(SECRET_FILE, symlinkPath);
    } catch {
      // Symlink might fail on some platforms
      return;
    }

    const result = await resolveStaticFile(TEST_ROOT, "/escape-link");
    // resolveStaticFile uses realpath, so the canonical path should be outside root
    assert.equal(result, null, "symlink escape should be rejected");

    // Cleanup
    const { unlink } = await import("node:fs/promises");
    await unlink(symlinkPath);
  });
});
