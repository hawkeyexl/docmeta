import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://hawkeyexl.github.io",
  base: "/docmeta",
  integrations: [
    starlight({
      title: "docmeta",
      sidebar: [
        {
          label: "Get started",
          autogenerate: { directory: "get-started" },
        },
        {
          label: "Set up validation",
          autogenerate: { directory: "set-up" },
        },
        {
          label: "Run it in CI",
          autogenerate: { directory: "ci" },
        },
        {
          label: "Define & evolve schemas",
          autogenerate: { directory: "schemas" },
        },
        {
          label: "Fix a failing check",
          autogenerate: { directory: "fix" },
        },
        {
          label: "Reference",
          autogenerate: { directory: "reference" },
        },
      ],
    }),
  ],
});
