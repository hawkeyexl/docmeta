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
          items: [{ autogenerate: { directory: "get-started" } }],
        },
        {
          label: "Set up validation",
          items: [{ autogenerate: { directory: "set-up" } }],
        },
        {
          label: "Run it in CI",
          items: [{ autogenerate: { directory: "ci" } }],
        },
        {
          label: "Define & evolve schemas",
          items: [{ autogenerate: { directory: "schemas" } }],
        },
        {
          label: "Fix a failing check",
          items: [{ autogenerate: { directory: "fix" } }],
        },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "reference" } }],
        },
      ],
    }),
  ],
});
