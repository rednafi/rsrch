import { defineConfig } from "astro/config";

// SITE and BASE let CI (and the scale test) build for another host or path.
export default defineConfig({
  site: process.env.SITE ?? "https://rednafi.github.io",
  base: process.env.BASE ?? "/rsrch",
  experimental: {
    // Split the content store into chunks so 100k docs don't become one huge JSON file.
    collectionStorage: "chunked",
  },
  markdown: {
    syntaxHighlight: { type: "shiki", excludeLangs: ["mermaid"] },
    shikiConfig: { themes: { light: "github-light", dark: "github-dark" } },
  },
});
