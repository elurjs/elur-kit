import { html } from "@elurjs/core";
import { island } from "../../../src/index.ts";
import type { PageProps } from "../../../src/index.ts";
import LikeButton from "../islands/LikeButton.ts";
import Counter from "../islands/Counter.ts";
import ContactForm from "../islands/ContactForm.ts";
import { load } from "./page.data.ts";

export default function HomePage({ data }: PageProps<typeof load>) {
  return html`
    <article class="home">
      <h1>${data.title}</h1>
      <p>${data.intro}</p>
      <ul>
        ${data.features.map((f) => html`<li>${f}</li>`)}
      </ul>
      ${island("LikeButton", LikeButton, { postId: "home-1" }, "load")}
      ${island("Counter", Counter, { start: 3, step: 2 }, "visible")}
      <h2>Newsletter</h2>
      ${island("ContactForm", ContactForm, {}, "visible")}
    </article>
  `;
}
