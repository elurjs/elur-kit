import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatBytes,
  formatDuration,
  fileRows,
  serverBannerLines,
  getNetworkAddress,
} from "../src/cli/output.ts";

describe("formatBytes", () => {
  it("formats bytes below 1 kB", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(640), "640 B");
    assert.equal(formatBytes(1023), "1023 B");
  });

  it("formats kilobytes", () => {
    assert.equal(formatBytes(1024), "1.0 kB");
    assert.equal(formatBytes(1536), "1.5 kB");
  });

  it("formats megabytes", () => {
    assert.equal(formatBytes(1024 * 1024), "1.0 MB");
    assert.equal(formatBytes(2.3 * 1024 * 1024), "2.3 MB");
  });
});

describe("formatDuration", () => {
  it("formats sub-second durations in ms", () => {
    assert.equal(formatDuration(45.4), "45ms");
    assert.equal(formatDuration(0), "0ms");
  });

  it("formats longer durations in seconds", () => {
    assert.equal(formatDuration(1234), "1.23s");
    assert.equal(formatDuration(1000), "1.00s");
  });
});

describe("fileRows", () => {
  it("lists all files when at most 20, aligning sizes", () => {
    const rows = fileRows([
      { path: "dist/index.html", bytes: 640 },
      { path: "dist/about/index.html", bytes: 1536 },
    ]);
    assert.deepEqual(rows, [
      "dist/index.html         640 B",
      "dist/about/index.html  1.5 kB",
    ]);
  });

  it("keeps the 10 largest and summarizes the rest beyond 20 files", () => {
    const files = Array.from({ length: 25 }, (_, i) => ({
      path: `dist/page-${String(i).padStart(2, "0")}.html`,
      bytes: (i + 1) * 100,
    }));
    const rows = fileRows(files);
    assert.equal(rows.length, 11);
    // Largest first.
    assert.ok(rows[0].startsWith("dist/page-24.html"));
    assert.ok(rows[9].startsWith("dist/page-15.html"));
    assert.equal(rows[10], "… and 15 more");
  });

  it("handles an empty list", () => {
    assert.deepEqual(fileRows([]), []);
  });
});

describe("serverBannerLines", () => {
  const base = {
    name: "elur-kit",
    version: "v2.4.10",
    command: "dev",
    localUrl: "http://localhost:3000/",
  };

  it("renders title and local URL without network URL", () => {
    assert.deepEqual(serverBannerLines(base), [
      "elur-kit v2.4.10 dev server running at:",
      "",
      "  → Local: http://localhost:3000/",
    ]);
  });

  it("aligns Local/Network labels when network URL is present", () => {
    const lines = serverBannerLines({
      ...base,
      networkUrl: "http://192.168.1.20:3000/",
    });
    assert.deepEqual(lines, [
      "elur-kit v2.4.10 dev server running at:",
      "",
      "  → Local:   http://localhost:3000/",
      "  → Network: http://192.168.1.20:3000/",
    ]);
  });
});

describe("getNetworkAddress", () => {
  it("returns a string or undefined", () => {
    const address = getNetworkAddress();
    assert.ok(address === undefined || typeof address === "string");
  });
});
