import type { PageDataLoad } from "../../../../src/index.ts";

export interface AboutData {
  title: string;
  mission: string;
}

export const load: PageDataLoad<AboutData> = async () => {
  return {
    title: "About Elur Kit",
    mission: "A full-stack framework for Elur with zero virtual DOM.",
  };
};
