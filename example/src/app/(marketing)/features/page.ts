import { html } from "@elurjs/core";
import type { PageProps } from "@elurjs/kit";

export default function FeaturesPage(_props: PageProps) {
  return html`
    <article class="features">
      <h1>Features</h1>
      <p>SSG, islands, file-based routing and more.</p>
    </article>
  `;
}
