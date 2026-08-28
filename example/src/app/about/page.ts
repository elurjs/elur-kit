import { html } from "@elurjs/core";
import type { PageProps } from "../../../../src/index.ts";
import type { AboutData } from "./page.data.ts";

export default function AboutPage({ data }: PageProps<AboutData>) {
  return html`
    <article class="about">
      <h1>${data.title}</h1>
      <p>${data.mission}</p>
      <a href="/">← Back home</a>
    </article>
  `;
}
