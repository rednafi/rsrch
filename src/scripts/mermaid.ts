// Render ```mermaid blocks. Shiki skips them (see astro.config.mjs), and the
// mermaid bundle loads only on pages that have one.
export async function renderMermaid() {
  const blocks = document.querySelectorAll<HTMLElement>("pre > code.language-mermaid");
  if (blocks.length === 0) return;
  const { default: mermaid } = await import("mermaid");
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", fontFamily: "inherit" });
  const nodes = [...blocks].map((code) => {
    const figure = document.createElement("figure");
    figure.className = "mermaid";
    figure.textContent = code.textContent;
    code.parentElement!.replaceWith(figure);
    return figure;
  });
  await mermaid.run({ nodes });
}
