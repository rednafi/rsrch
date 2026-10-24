# rsrch

Long-form research notes, published at https://rednafi.github.io/rsrch/.

The site is built with [Astro](https://astro.build) and searched with
[Pagefind](https://pagefind.app). It has no server: GitHub Pages serves static files,
and search runs in the browser.

## Add a doc

Make a folder in `src/content/docs/` with an `index.md`. Put images and other files
next to it and link them with relative paths.

```md
---
title: A short title
slug: a-short-title        # the URL: /docs/a-short-title/
description: One or two sentences for the card and the search result.
date: 2026-10-24
tags: [go, design]
---

Text starts here. Use ## for sections; they make the table of contents.
```

A ```mermaid code block renders as a diagram.

## Commands

| Command                | What it does                                                    |
| ---------------------- | --------------------------------------------------------------- |
| `npm run dev`          | Dev server on http://localhost:4321/rsrch/ (search needs a build) |
| `npm run build`        | Build to `dist/` and index it with Pagefind                     |
| `npm run check`        | Type-check the code and validate every doc's frontmatter        |
| `npm run test:screens` | Screenshot 5 screen sizes and fail on layout bugs (see below)   |
| `npm run test:scale`   | Build from 100k generated docs and time searches in a browser   |

A push to `main` runs `.github/workflows/deploy.yml`: check, build, then deploy to Pages.

## Layout

```
src/
  content.config.ts          the docs collection and its frontmatter schema
  content/docs/<doc>/        one folder per doc: index.md and its files
  lib/docs.ts                URL, sorting and date helpers
  layouts/Base.astro         the page shell: header, search, footer
  pages/[...page].astro      the home page, 30 docs per page
  pages/docs/[...id].astro   a doc, with its table of contents
  components/                Search, Toc and DocCard
  scripts/search.ts          the search dialog, on the Pagefind API
  scripts/mermaid.ts         renders mermaid blocks, loaded only when a page has one
  styles/global.css          all styles, light and dark
scripts/
  screens.mjs                screenshot and layout test
  scale.mjs                  100k-doc build and search test
  serve.mjs                  a static server for both tests
```

## How it scales

Three choices keep a large site fast:

- **Search downloads only what a query needs.** Pagefind splits the index into small
  chunks, and the browser fetches only the chunks for the words you type. The search runs
  in a Web Worker, so the page stays responsive.
- **Words in almost every doc are dropped from queries.** Search time grows with the
  number of matching pages. "the" matches every page, and because all query words must
  match, it doesn't narrow the results anyway.
- **The build stays flat in memory.** The content store is chunked
  (`experimental.collectionStorage`), and it keeps rendered HTML only, not the Markdown
  too. Without this, Astro runs out of memory near 100k docs. List pages are paginated, so
  no page grows with the number of docs.

Results of `node scripts/scale.mjs 100000` on an M-series MacBook. Each doc has 400
words sampled from the real docs, so word frequencies match real text:

| Step                    | Result                                |
| ----------------------- | ------------------------------------- |
| Astro build, 100k docs  | 76 s, 103,435 files, 606 MB           |
| Pagefind index          | 108 s, 219 MB in 101,079 files        |

| Query                 | Matches | Time to results | Downloaded |
| --------------------- | ------: | --------------: | ---------: |
| `marker99999`         |       1 |          170 ms |     647 KB |
| `circuit breaker`     |  11,091 |           3.7 s |     730 KB |
| `the circuit breaker` |  11,091 |           3.7 s |     730 KB |
| `jitter`              |  49,263 |           8.8 s |     713 KB |
| `the`                 | skipped |           32 ms |      44 KB |

What to expect:

- A query costs about 0.2 to 0.3 ms per matching page. Specific queries take well under
  a second. A word that's in tens of thousands of docs takes seconds. The test corpus is
  harsher than real docs here, because every doc is sampled from the same two texts.
- GitHub Pages caps a site at 1 GB. The 100k-doc test site is 825 MB with its index. A
  site of 100k long docs needs a host without that cap.
