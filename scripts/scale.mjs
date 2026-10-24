// Scale test: build the site from N generated docs, then measure search in a browser.
//
//   node scripts/scale.mjs [count=100000] [--search-only]
//
// Docs go to tmp/scale/docs and the site to tmp/scale/dist. Neither touches the real
// content. Each doc is prose sampled from the words of the real docs, so common words
// ("the") are in nearly every doc and rare ones ("jitter") are not, as in real text.
// Each doc also has a unique word, `marker<i>`, so a query has a known answer.
// --search-only skips the build and measures search on the last one.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { serve } from "./serve.mjs";

const args = process.argv.slice(2);
const COUNT = Number(args.find((a) => /^\d+$/.test(a)) ?? 100_000);
const SEARCH_ONLY = args.includes("--search-only");
const WORDS_PER_DOC = 400;
const ROOT = "tmp/scale";
const DOCS = join(ROOT, "docs");
const DIST = join(ROOT, "dist");
// Every word of the real docs, repeats included. Sampling from it keeps real word frequencies.
const WORDS = readdirSync("src/content/docs", { recursive: true })
  .filter((file) => file.endsWith(".md"))
  .flatMap((file) => readFileSync(join("src/content/docs", file), "utf8").toLowerCase().match(/[a-z]{2,}/g) ?? []);

function seconds(start) {
  return ((performance.now() - start) / 1000).toFixed(1);
}

function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(dir, { recursive: true })) {
    const stat = statSync(join(dir, entry));
    if (stat.isFile()) {
      bytes += stat.size;
      files++;
    }
  }
  return { mb: (bytes / 1e6).toFixed(1), files };
}

// A seeded generator keeps runs comparable.
let seed = 42;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const word = () => WORDS[Math.floor(random() * WORDS.length)];
const sentence = (n) => Array.from({ length: n }, word).join(" ");

function generate() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(DOCS, { recursive: true });
  for (let i = 0; i < COUNT; i++) {
    const half = WORDS_PER_DOC / 2;
    const body = [`## ${sentence(4)}`, `${sentence(half)} marker${i}.`, `## ${sentence(3)}`, sentence(half)].join("\n\n");
    const date = new Date(Date.UTC(2020, 0, 1) + i * 60_000).toISOString();
    writeFileSync(
      join(DOCS, `doc-${i}.md`),
      `---\ntitle: "Note ${i}: ${sentence(3)}"\ndescription: "${sentence(12)}"\ndate: ${date}\ntags: ["${word()}"]\n---\n\n${body}\n`,
    );
  }
}

function build() {
  const env = { ...process.env, DOCS_DIR: `./${DOCS}` };
  execFileSync("npx", ["astro", "build", "--outDir", DIST], { env, stdio: ["ignore", "ignore", "inherit"] });
}

function index() {
  execFileSync("npx", ["pagefind", "--site", DIST], { stdio: ["ignore", "ignore", "inherit"] });
}

async function measureSearch(queries) {
  const server = await serve(DIST, 4330);
  const browser = await chromium.launch();
  const results = [];
  for (const query of queries) {
    const page = await browser.newPage();
    let indexBytes = 0;
    page.on("response", async (response) => {
      if (response.url().includes("/pagefind/")) indexBytes += (await response.body().catch(() => Buffer.alloc(0))).length;
    });
    await page.goto(server.url, { waitUntil: "networkidle" });
    await page.locator("[data-search-open]").click();
    const start = performance.now();
    await page.locator(".search input").fill(query.text);
    // Time from typing to a final status, through the real search dialog.
    await page.waitForFunction(() => {
      const status = document.querySelector(".search-status")?.textContent ?? "";
      return status !== "" && status !== "Searching…";
    }, null, { timeout: 180_000 });
    const ms = Math.round(performance.now() - start);
    await page.waitForLoadState("networkidle");
    const status = await page.locator(".search-status").textContent();
    const first = (await page.locator(".search-results li strong").first().textContent({ timeout: 1000 }).catch(() => null)) ?? "";
    const ok = query.expect === null ? first === "" : first.startsWith(query.expect);
    results.push({ query: query.text, ms, status, kbDownloaded: Math.round(indexBytes / 1024), firstResult: first, ok });
    await page.close();
  }
  await browser.close();
  server.close();
  return results;
}

if (!SEARCH_ONLY) {
  let start = performance.now();
  generate();
  console.log(`generated ${COUNT} docs of ${WORDS_PER_DOC} words in ${seconds(start)}s`);

  start = performance.now();
  build();
  const site = dirSize(DIST);
  console.log(`astro build: ${seconds(start)}s, ${site.files} files, ${site.mb} MB`);

  start = performance.now();
  index();
  const size = dirSize(join(DIST, "pagefind"));
  console.log(`pagefind index: ${seconds(start)}s, ${size.mb} MB in ${size.files} files`);
}

const last = COUNT - 1;
const mid = Math.floor(COUNT / 2);
const results = await measureSearch([
  { text: `marker${last}`, expect: `Note ${last}:` },
  { text: `marker${mid}`, expect: `Note ${mid}:` },
  { text: "circuit breaker", expect: "Note" },
  { text: "the circuit breaker", expect: "Note" }, // "the" is dropped, so same cost as above
  { text: "jitter", expect: "Note" },
  { text: "the", expect: null }, // only a stop word: a hint, no search
]);
console.table(results);
process.exit(results.every((r) => r.ok) ? 0 : 1);
