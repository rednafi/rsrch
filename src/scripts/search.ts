// Search dialog over the Pagefind JS API: https://pagefind.app/docs/api/

type PagefindResult = {
  url: string;
  excerpt: string;
  meta: { title?: string };
  sub_results?: Section[];
};
type Section = { title: string; url: string; excerpt: string; locations: number[] };
type Pagefind = {
  options(opts: { baseUrl?: string; excerptLength?: number }): Promise<void>;
  debouncedSearch(query: string, opts?: object, ms?: number): Promise<{ results: { data(): Promise<PagefindResult> }[] } | null>;
};

const MAX_RESULTS = 10;
const MAX_SECTIONS = 3;

// Words that are in nearly every doc. Pagefind's time grows with the number of pages a
// word matches (about 35s for "the" at 100k docs), and since all words must match,
// these words don't narrow the results. So they are dropped, except in "quoted phrases".
const STOP_WORDS = new Set(
  "a an and are as at be but by can do for from has have how i if in into is it its of on or so that the their then there these this to was we were what when which will with you".split(" "),
);

function meaningfulQuery(query: string): string {
  if (query.includes('"')) return query;
  return query
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word.toLowerCase()))
    .join(" ");
}

export function mountSearch(dialog: HTMLDialogElement) {
  const input = dialog.querySelector("input")!;
  const list = dialog.querySelector<HTMLOListElement>(".search-results")!;
  const status = dialog.querySelector<HTMLParagraphElement>(".search-status")!;
  const indexPath = dialog.dataset.pagefindPath!;
  let pagefind: Promise<Pagefind> | undefined;

  // Load the index runtime on first use, not on page load.
  function loadPagefind(): Promise<Pagefind> {
    pagefind ??= import(/* @vite-ignore */ `${indexPath}pagefind.js`).then(async (pf: Pagefind) => {
      // The index lives at <base>/pagefind/, so its parent is the site base for result URLs.
      await pf.options({ baseUrl: new URL("..", new URL(indexPath, location.href)).pathname, excerptLength: 24 });
      return pf;
    });
    return pagefind;
  }

  function open() {
    if (dialog.open) return;
    dialog.showModal();
    input.select();
    loadPagefind().catch(() => (status.textContent = "The search index is built by npm run build."));
  }

  async function search(input: string) {
    const query = meaningfulQuery(input.trim());
    if (!query) {
      list.replaceChildren();
      status.textContent = input.trim() ? "Keep typing: that word is in almost every doc." : "";
      return;
    }
    status.textContent = "Searching…";
    const response = await (await loadPagefind()).debouncedSearch(query, {}, 120);
    if (response === null) return; // a newer query replaced this one
    const results = await Promise.all(response.results.slice(0, MAX_RESULTS).map((r) => r.data()));
    const total = response.results.length;
    status.textContent = total === 0 ? `No results for “${input.trim()}”` : `${total} result${total === 1 ? "" : "s"}`;
    list.replaceChildren(...results.map(renderResult));
  }

  /** A doc title, then its sections with the most matches, each a link to its heading. */
  function renderResult(result: PagefindResult): HTMLLIElement {
    const sections = (result.sub_results ?? [])
      .filter((s) => s.url !== result.url)
      .sort((a, b) => b.locations.length - a.locations.length)
      .slice(0, MAX_SECTIONS);
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = result.meta.title ?? result.url;
    item.append(title);
    const links = sections.length > 0 ? sections : [{ title: "", url: result.url, excerpt: result.excerpt }];
    for (const section of links) item.append(sectionLink(section.url, section.title, section.excerpt));
    return item;
  }

  function sectionLink(href: string, heading: string, excerptHtml: string): HTMLAnchorElement {
    const link = document.createElement("a");
    link.href = href;
    if (heading) {
      const crumb = document.createElement("span");
      crumb.className = "search-section";
      crumb.textContent = heading;
      link.append(crumb);
    }
    const excerpt = document.createElement("p");
    excerpt.innerHTML = excerptHtml; // Pagefind escapes the text and adds <mark>
    link.append(excerpt);
    return link;
  }

  function moveFocus(step: number) {
    const links = [...list.querySelectorAll("a")];
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next = links[index + step];
    if (next) next.focus();
    else if (step < 0) input.focus();
  }

  input.addEventListener("input", () => search(input.value));
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") moveFocus(1);
    else if (event.key === "ArrowUp") moveFocus(-1);
    else return;
    event.preventDefault();
  });
  // A click on the backdrop (outside the panel) closes the dialog.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.querySelectorAll("[data-search-open]").forEach((button) => button.addEventListener("click", open));
  document.addEventListener("keydown", (event) => {
    const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]");
    if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
      event.preventDefault();
      open();
    }
  });
}
