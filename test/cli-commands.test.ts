import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { doRoutes, doDoctor, formatError, ExitCode } from "../src/cli/commands.ts";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CliOptions } from "../src/cli.ts";

const TEST_ROOT = join(tmpdir(), `elur-cli-test-${Date.now()}`);

before(async () => {
  await mkdir(join(TEST_ROOT, "src", "app", "blog", "[slug]"), { recursive: true });
  await mkdir(join(TEST_ROOT, "src", "app", "about"), { recursive: true });
  await mkdir(join(TEST_ROOT, "src", "islands"), { recursive: true });
  await mkdir(join(TEST_ROOT, "public"), { recursive: true });
  await writeFile(join(TEST_ROOT, "src", "app", "page.ts"), "export default () => null;");
  await writeFile(join(TEST_ROOT, "src", "app", "blog", "[slug]", "page.ts"), "export default () => null;");
  await writeFile(join(TEST_ROOT, "src", "app", "about", "page.ts"), "export default () => null;");
  await writeFile(join(TEST_ROOT, "tsconfig.json"), "{}");
});

after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

function makeOptions(root: string, overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    command: "routes",
    root,
    appDir: join(root, "src", "app"),
    islandsDir: join(root, "src", "islands"),
    outDir: join(root, "dist"),
    publicDir: join(root, "public"),
    generatedEntry: join(root, ".elur", "entry-client.ts"),
    clientEntry: "/_elur/entry-client.js",
    port: 3000,
    host: "127.0.0.1",
    lang: "en",
    ...overrides,
  };
}

describe("CLI: routes command (plan §12.1)", () => {
  it("lists all discovered routes", async () => {
    const code = await doRoutes(makeOptions(TEST_ROOT));
    assert.equal(code, ExitCode.Success);
  });

  it("returns route conflict error on duplicate routes", async () => {
    const conflictRoot = join(tmpdir(), `elur-cli-conflict-${Date.now()}`);
    await mkdir(join(conflictRoot, "page"), { recursive: true });
    await mkdir(join(conflictRoot, "(group)", "page"), { recursive: true });
    await writeFile(join(conflictRoot, "page", "page.ts"), "export default () => null;");
    await writeFile(join(conflictRoot, "(group)", "page", "page.ts"), "export default () => null;");

    const code = await doRoutes(makeOptions(conflictRoot, { appDir: conflictRoot }));
    assert.equal(code, ExitCode.RouteConflict);

    await rm(conflictRoot, { recursive: true, force: true });
  });
});

describe("CLI: doctor command (plan §12.1)", () => {
  it("diagnoses a healthy project", async () => {
    const code = await doDoctor(makeOptions(TEST_ROOT));
    // May have warnings for missing optional peers, but should succeed.
    assert.equal(code, ExitCode.Success);
  });

  it("reports missing app directory", async () => {
    const emptyRoot = join(tmpdir(), `elur-cli-empty-${Date.now()}`);
    await mkdir(emptyRoot, { recursive: true });
    const code = await doDoctor(makeOptions(emptyRoot));
    assert.equal(code, ExitCode.GenericError, "should error when app dir is missing");
    await rm(emptyRoot, { recursive: true, force: true });
  });
});

describe("CLI: formatError (plan §12.1)", () => {
  it("formats error with cause only", () => {
    const result = formatError("Something went wrong");
    assert.equal(result, "Something went wrong");
  });

  it("formats error with cause and path", () => {
    const result = formatError("File not found", "/path/to/file.ts");
    assert.ok(result.includes("File not found"));
    assert.ok(result.includes("/path/to/file.ts"));
  });

  it("formats error with cause, path, and suggestion", () => {
    const result = formatError("File not found", "/path/to/file.ts", "Create the file");
    assert.ok(result.includes("File not found"));
    assert.ok(result.includes("/path/to/file.ts"));
    assert.ok(result.includes("Create the file"));
  });
});
