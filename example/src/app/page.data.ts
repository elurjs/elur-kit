import type { PageDataLoad } from "../../../src/index.ts";

export interface HomeData {
  title: string;
  intro: string;
  features: string[];
}

export const load: PageDataLoad<HomeData> = async () => {
  return {
    title: "Hello Elur Kit",
    intro:
      "Este HTML fue generado en build-time con renderToString, sin navegador.",
    features: ["SSG", "Islands", "SSR"],
  };
};
