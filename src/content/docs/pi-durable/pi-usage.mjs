// Aggregate pi session usage: tools, prompt templates, skills, aborts, errors, compaction, durations.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const root = process.env.HOME + "/.pi/agent/sessions";
const files = [];
for (const d of readdirSync(root)) for (const f of readdirSync(join(root, d))) if (f.endsWith(".jsonl")) files.push(join(root, d, f));
const c = (m, k, n = 1) => (m[k] = (m[k] ?? 0) + n);
const tools = {}, prompts = {}, skills = {}, customs = {}, stop = {}, subagentModes = {}, mcp = {}, cwd = {};
let aborted = 0, errored = 0, compactions = 0, toolErrors = 0, userMsgs = 0, cost = 0;
const durations = [], msgCounts = [];
let longSessions = 0, bigSessions = 0, retriesAfterAbort = 0;
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
  let first, last, n = 0, lastWasAbort = false;
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === "session") { c(cwd, e.cwd.replace(process.env.HOME, "~").split("/").slice(0, 4).join("/")); }
    if (e.timestamp) { const t = Date.parse(e.timestamp); first ??= t; last = t; }
    if (e.type === "compaction") compactions++;
    if (e.type === "custom" || e.type === "custom_message") c(customs, e.customType);
    if (e.type !== "message") continue;
    const m = e.message; n++;
    if (m.role === "user") {
      userMsgs++;
      const txt = typeof m.content === "string" ? m.content : (m.content ?? []).map((x) => x.text ?? "").join("");
      if (lastWasAbort) retriesAfterAbort++;
      lastWasAbort = false;
      const sk = txt.match(/<skill name="([^"]+)"/); if (sk) c(skills, sk[1]);
    }
    if (m.role === "assistant") {
      c(stop, m.stopReason ?? "?");
      if (m.stopReason === "aborted") { aborted++; lastWasAbort = true; }
      if (m.stopReason === "error") errored++;
      cost += m.usage?.cost?.total ?? 0;
      for (const p of m.content ?? []) if (p.type === "toolCall") {
        c(tools, p.name);
        if (p.name === "subagent") c(subagentModes, p.arguments?.chain ? "chain" : p.arguments?.tasks ? "parallel" : "single");
        if (p.name === "codemode") for (const s of (p.arguments?.code ?? "").matchAll(/tools\.(mcp__\w+?)__/g)) c(mcp, s[1]);
      }
    }
    if (m.role === "toolResult" && m.isError) toolErrors++;
  }
  // prompt template expansions are recorded on the raw file text
  const raw = lines.join("\n");
  for (const p of raw.matchAll(/"\/(p-[a-z]+)\b/g)) c(prompts, p[1]);
  const dur = (last - first) / 60000; durations.push(dur); msgCounts.push(n);
  if (dur > 60) longSessions++;
  if (statSync(f).size > 5e6) bigSessions++;
}
const top = (m, k = 15) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, k);
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(JSON.stringify({
  sessions: files.length, userMsgs, assistantStop: stop, aborted, errored, retriesAfterAbort, toolErrors, compactions,
  costUSD: +cost.toFixed(2), medianMinutes: +med(durations).toFixed(1), sessionsOver60min: longSessions,
  maxMessages: Math.max(...msgCounts), sessionsOver5MB: bigSessions,
  tools: top(tools, 20), subagentModes, mcpServersViaCodemode: top(mcp), promptTemplates: top(prompts), skills: top(skills),
  customEntries: top(customs), cwdTop: top(cwd, 8),
}, null, 1));
