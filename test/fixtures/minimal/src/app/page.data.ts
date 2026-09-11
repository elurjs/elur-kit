import type { PageDataLoad } from "../../../../../src/index.ts";

export interface HomeData {
  title: string;
  metadata?: { title?: string; description?: string };
}

export const load: PageDataLoad<HomeData> = async () => {
  return {
    title: "Hello from test",
    metadata: { title: "Home", description: "fixture description" },
  };
};

export const revalidate = 60;
