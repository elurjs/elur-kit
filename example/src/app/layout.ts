import { html } from "@elurjs/core";
import type { LayoutProps } from "../../../src/index.ts";

export default function RootLayout({ children }: LayoutProps) {
  return html`
    <div class="site">
      <header>
        <a href="/">Home</a>
        <a href="/about">About</a>
        <a href="/pricing">Pricing</a>
        <a href="/features">Features</a>
      </header>
      <main>${children}</main>
      <footer>Elur Kit v0.1</footer>
    </div>
  `;
}
