import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { html, signal, computed } from "@elurjs/core";
import { renderToString } from "@elurjs/core/server";
import { hydrate } from "@elurjs/core/hydrate";
import { island } from "../src/island/island.ts";
import { hydrateIslands, cleanupHydratedIslands } from "../src/island/hydrate.ts";

const movies = [
  { title: "Inception", genres: ["Sci-Fi"] },
  { title: "Mad Max", genres: ["Sci-Fi"] },
  { title: "Everything", genres: ["Sci-Fi"] },
  { title: "Spirited Away", genres: ["Animation"] },
];

function SearchMovies(props) {
  const genre = signal(props.initialGenre ?? null);
  const visible = computed(() => {
    const g = genre.value;
    return movies.filter((m) => !g || m.genres.includes(g));
  });
  const count = computed(() => visible.value.length);
  return html`
    <div>
      <button @click=${() => (genre.value = genre.value === "Sci-Fi" ? null : "Sci-Fi")}>Sci-Fi</button>
      <p>${() => count.value} resultado(s)</p>
      <div class="movie-grid">
        ${() => visible.value.map((m) => html`<article class="movie-card">${m.title}</article>`)}
      </div>
    </div>
  `;
}

describe("island reactive array + computed repro", () => {
  it("filters after a click post-hydration", async () => {
    const window = new Window({ url: "http://localhost/" });
    const g = globalThis as Record<string, unknown>;
    g.window = window; g.document = window.document; g.Node = window.Node;
    g.NodeFilter = window.NodeFilter; g.Comment = window.Comment; g.Text = window.Text;
    g.Element = window.Element; g.HTMLElement = window.HTMLElement;

    const tpl = island("Search", SearchMovies, { initialGenre: null }, "load");
    const container = document.createElement("div");
    container.innerHTML = await renderToString(tpl);
    document.body.appendChild(container);
    document.body.innerHTML = container.innerHTML;

    hydrateIslands({ Search: SearchMovies } as never);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(document.querySelectorAll(".movie-card").length, 4, "initial 4 cards");
    assert.equal(document.querySelector("p")!.textContent, "4 resultado(s)");

    const btn = document.querySelector("button")!;
    btn.click();
    await new Promise((r) => setTimeout(r, 10));
    const cards = Array.from(document.querySelectorAll(".movie-card h3"));
    void cards;
    assert.equal(document.querySelectorAll(".movie-card").length, 3, "3 sci-fi cards after click");
    assert.equal(document.querySelector("p")!.textContent, "3 resultado(s)");
    cleanupHydratedIslands();
  });
});
