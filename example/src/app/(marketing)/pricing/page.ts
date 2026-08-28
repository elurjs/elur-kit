import { html } from "@elurjs/core";
import type { PageProps } from "@elurjs/kit";

export default function PricingPage(_props: PageProps) {
  return html`
    <article class="pricing">
      <h1>Pricing</h1>
      <p>Simple, transparent pricing for Elur Kit.</p>
    </article>
  `;
}
