import { getCollection, type CollectionEntry } from "astro:content";

export type Doc = CollectionEntry<"docs">;

/** Prefix a site path with the deploy base, e.g. "docs/x" -> "/rsrch/docs/x". */
export function url(path = ""): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}/${path.replace(/^\//, "")}`;
}

/** All docs, newest first. */
export async function allDocs(): Promise<Doc[]> {
  const docs = await getCollection("docs");
  return docs.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Reading time at 230 words per minute, counted from the rendered text. */
export function readingMinutes(doc: Doc): number {
  const text = doc.rendered?.html.replace(/<[^>]+>/g, " ") ?? "";
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 230));
}
