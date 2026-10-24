// Screenshot the site at phone, tablet and desktop sizes, and fail on layout bugs.
//
//   node scripts/screens.mjs                         # tests ./dist on a local server
//   node scripts/screens.mjs https://rednafi.github.io/rsrch/
//
// Writes screens/<viewport>-<page>.png. Exits 1 if any check fails.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { serve } from "./serve.mjs";

const VIEWPORTS = [
  { name: "phone", width: 375, height: 740, isMobile: true },
  { name: "phone-large", width: 430, height: 932, isMobile: true },
  { name: "tablet", width: 820, height: 1180, isMobile: true },
  { name: "laptop", width: 1280, height: 800 },
  { name: "desktop", width: 1920, height: 1080 },
];
const PAGES = [
  { name: "home", path: "" },
  { name: "aws-go-sdk", path: "docs/aws-go-sdk/" },
  { name: "pi-durable-diagrams", path: "docs/pi-durable/", scrollTo: "#architecture" },
  { name: "search", path: "", search: "circuit breaker" },
];

/** Layout checks that run inside the page. Returns a list of problems. */
async function checkPage() {
  const problems = [];
  const width = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > width) {
    // Name the widest elements that are not inside their own scroll box.
    const culprits = [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > width + 1)
      .filter((el) => !el.closest("pre, table, .mermaid, .toc"))
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
    problems.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${width}px): ${culprits.join(", ")}`);
  }
  // Images are lazy, so fetch each one instead of reading its load state.
  for (const img of document.images) {
    const response = await fetch(img.src);
    if (!response.ok) problems.push(`image ${img.src} returned ${response.status}`);
  }
  return problems;
}

const target = process.argv[2];
const local = target ? undefined : await serve("dist", 4329);
const baseUrl = target ?? local.url;
mkdirSync("screens", { recursive: true });

const browser = await chromium.launch();
const failures = [];
for (const viewport of VIEWPORTS) {
  for (const colorScheme of viewport.name === "laptop" ? ["light", "dark"] : ["light"]) {
    const context = await browser.newContext({ viewport, isMobile: viewport.isMobile, hasTouch: viewport.isMobile, colorScheme, deviceScaleFactor: 2 });
    const page = await context.newPage();
    for (const target of PAGES) {
      const label = `${viewport.name}${colorScheme === "dark" ? "-dark" : ""}-${target.name}`;
      await page.goto(new URL(target.path, baseUrl).href, { waitUntil: "networkidle" });
      const problems = await page.evaluate(checkPage);

      if (target.scrollTo) {
        await page.waitForSelector("figure.mermaid svg", { timeout: 10_000 }).catch(() => problems.push("mermaid diagram did not render"));
        await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "start" }), target.scrollTo);
      }
      if (target.search) {
        await page.locator("[data-search-open]").click();
        await page.locator(".search input").fill(target.search);
        await page.waitForSelector(".search-results li", { timeout: 10_000 }).catch(() => problems.push(`no results for "${target.search}"`));
        await page.waitForTimeout(300);
      }
      await page.screenshot({ path: `screens/${label}.png` });
      console.log(`${problems.length ? "FAIL" : "ok  "} ${label}${problems.length ? `: ${problems.join("; ")}` : ""}`);
      failures.push(...problems.map((p) => `${label}: ${p}`));
    }
    await context.close();
  }
}
await browser.close();
local?.close();
console.log(failures.length ? `\n${failures.length} problem(s)` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
