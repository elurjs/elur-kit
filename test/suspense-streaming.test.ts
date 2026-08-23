import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFallbackHtml, buildResolvedChunk } from "../src/middleware/stream-boundary.ts";

// Fix #4: Real Suspense streaming with <template> replacement

describe("Fix #4: Suspense streaming (<template> replacement)", () => {
  it("buildFallbackHtml wraps fallback in a boundary div", () => {
    const html = buildFallbackHtml("nix-js-stream-abc", "<p>Loading...</p>");
    assert.ok(html.includes('id="nix-js-stream-abc"'), "contains boundary ID");
    assert.ok(html.includes('data-nix-js-boundary="nix-js-stream-abc"'), "contains data attribute");
    assert.ok(html.includes("<p>Loading...</p>"), "contains fallback content");
    assert.ok(html.includes('style="display:contents"'), "uses display:contents for layout neutrality");
  });

  it("buildResolvedChunk emits a <template> with resolved content", () => {
    const chunk = buildResolvedChunk("nix-js-stream-abc", "<h1>Resolved</h1>");
    assert.ok(chunk.includes('<template id="nix-js-stream-abc-tpl">'), "contains template element with boundary ID");
    assert.ok(chunk.includes("<h1>Resolved</h1>"), "contains resolved content inside template");
  });

  it("buildResolvedChunk emits a replacement script", () => {
    const chunk = buildResolvedChunk("nix-js-stream-abc", "<div>Content</div>");
    assert.ok(chunk.includes("<script>"), "contains a script tag");
    assert.ok(chunk.includes('getElementById("nix-js-stream-abc-tpl")'), "script finds template element");
    assert.ok(chunk.includes('getElementById("nix-js-stream-abc")'), "script finds fallback element");
    assert.ok(chunk.includes("replaceWith"), "script uses replaceWith for DOM swap");
    assert.ok(chunk.includes("t.content.cloneNode(true)"), "script clones template content");
  });

  it("buildResolvedChunk dispatches nix-js:rendered event", () => {
    const chunk = buildResolvedChunk("nix-js-stream-abc", "<div>Content</div>");
    assert.ok(
      chunk.includes('CustomEvent("nix-js:rendered")'),
      "script dispatches nix-js:rendered event for island re-hydration",
    );
  });

  it("buildResolvedChunk does NOT use innerHTML (real replacement, not append)", () => {
    const chunk = buildResolvedChunk("nix-js-stream-abc", "<div>Content</div>");
    // The old approach used el.innerHTML = ...; the new one uses replaceWith.
    assert.ok(!chunk.includes(".innerHTML ="), "must not use innerHTML assignment");
    assert.ok(chunk.includes("replaceWith"), "must use replaceWith for in-place DOM swap");
  });

  it("buildResolvedChunk safely escapes boundary IDs in script", () => {
    // Even with a normal ID, the script must use JSON.stringify for safety.
    const chunk = buildResolvedChunk("nix-js-stream-abc", "<div>Content</div>");
    // The script should use JSON.stringify'd strings, not raw interpolation.
    assert.ok(chunk.includes('"nix-js-stream-abc-tpl"'), "template ID is quoted safely");
    assert.ok(chunk.includes('"nix-js-stream-abc"'), "boundary ID is quoted safely");
  });
});
