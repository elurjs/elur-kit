import { html } from "@elurjs/core";
import { elurJsAction } from "../../../src/action/index.ts";

export default function ContactForm() {
  const contact = elurJsAction("subscribe", { page: "/" });

  return html`
    <form
      class="contact-form"
      @submit=${(e: Event) => {
        e.preventDefault();
        const form = e.target as HTMLFormElement;
        const email = (form.elements.namedItem("email") as HTMLInputElement).value;
        contact.submit({ email });
      }}
    >
      <label>
        Email
        <input type="email" name="email" required />
      </label>
      <button type="submit" disabled=${() => contact.pending.value}>
        ${() => (contact.pending.value ? "Subscribing..." : "Subscribe")}
      </button>
      ${() =>
        contact.error.value
          ? html`<p class="error">${contact.error.value.message}</p>`
          : null}
      ${() =>
        contact.data.value
          ? html`<p class="success">${contact.data.value}</p>`
          : null}
    </form>
  `;
}
