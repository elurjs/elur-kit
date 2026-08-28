import { html } from "@elurjs/core";
import type { LayoutProps } from "@elurjs/kit";

export default function MarketingLayout({ children }: LayoutProps) {
  return html`
    <div class="marketing-layout">
      <nav>
        <a href="/pricing">Pricing</a>
        <a href="/features">Features</a>
      </nav>
      <section>${children}</section>
    </div>
  `;
}
