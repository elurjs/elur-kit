// --- Public types (v0.1 subset) ---

/** Route params: `[slug]` -> string, `[...slug]` -> string[]. */
export type RouteParams = Record<string, string | string[]>;

/** Infer the data type from a loader type, supporting both plain types and functions. */
type InferLoaderData<T> = T extends (...args: any[]) => infer R ? Awaited<R> : T;

/** Props received by a `page.ts` component's default export. */
export type PageProps<TData = unknown, TLayout = unknown> = {
  /** Return value of the route's `page.data.ts` loader. */
  data: InferLoaderData<TData>;
  /** Return value of the nearest `layout.data.ts` loader, if any. */
  layoutData?: InferLoaderData<TLayout>;
  /** Dynamic segment values. */
  params: RouteParams;
  /** Parsed query string. */
  searchParams: URLSearchParams;
  /** Return value of the last executed action (POST). */
  form?: unknown;
};

/** Props received by a `layout.ts` component's default export. */
export type LayoutProps<TData = unknown> = {
  /** Slot where the child page/layout is rendered. */
  children: unknown;
  /** Return value of this layout's `layout.data.ts`, if any. */
  data?: InferLoaderData<TData>;
};

/** Context passed to a `load` function. */
export interface LoadContext {
  params: RouteParams;
  searchParams: URLSearchParams;
  request?: Request;
}

/** Signature for `page.data.ts` / `layout.data.ts` `load` export. */
export type PageDataLoad<TData = unknown> = (
  ctx: LoadContext,
) => Promise<TData> | TData;

/** Signature for `generateStaticParams` in dynamic page modules. */
export type GenerateStaticParams = () =>
  | Promise<RouteParams[]>
  | RouteParams[];

/** OpenGraph metadata for a page. */
export interface OpenGraphMetadata {
  /** OG type: website, article, profile, etc. */
  type?: string;
  /** OG title (falls back to the page title). */
  title?: string;
  /** OG description (falls back to the page description). */
  description?: string;
  /** Absolute or relative URL to the canonical page. */
  url?: string;
  /** Image URL for social sharing previews. */
  image?: string;
  /** Image alternative text. Emitted as `og:image:alt`. */
  imageAlt?: string;
  /** Image width in pixels. Emitted as `og:image:width`. */
  imageWidth?: number;
  /** Image height in pixels. Emitted as `og:image:height`. */
  imageHeight?: number;
  /** Image MIME type (e.g. "image/png"). Emitted as `og:image:type`. */
  imageType?: string;
  /** Site name shown in social cards. */
  siteName?: string;
  /** Locale, e.g. "es_ES". */
  locale?: string;
}

/** Twitter card metadata for a page. */
export interface TwitterMetadata {
  /** Card type: summary, summary_large_image, player, app. */
  card?: "summary" | "summary_large_image" | "player" | "app";
  /** Title (falls back to the page title). */
  title?: string;
  /** Description (falls back to the page description). */
  description?: string;
  /** Image URL for the card. */
  image?: string;
  /** Image alternative text. Emitted as `twitter:image:alt`. */
  imageAlt?: string;
}

/** Page-level metadata emitted into the `<head>` by the document shell. */
export interface PageMetadata {
  /** Page title (also used as `<title>` and as fallback for OG/Twitter). */
  title?: string;
  /** Meta description. */
  description?: string;
  /** Canonical URL. */
  canonical?: string;
  /** Robots directive, e.g. "index, follow" or "noindex". */
  robots?: string;
  /** OpenGraph metadata for social sharing. */
  openGraph?: OpenGraphMetadata;
  /** Twitter card metadata. */
  twitter?: TwitterMetadata;
  /** Additional `<meta>` tags as key/value pairs. */
  other?: Record<string, string>;
}

/** Context passed to a `generateMetadata` function. */
export interface MetadataContext extends LoadContext {
  /** Loader data resolved for the current page, if a loader exists. */
  data?: unknown;
}

/** Signature for `generateMetadata` exported by `page.ts` modules. */
export type GenerateMetadata = (
  ctx: MetadataContext,
) => Promise<PageMetadata> | PageMetadata;
