// Phase "crash": start a run whose tools take 4s, get SIGKILLed mid-tool by the shell.
// Phase "resume": a new process reopens the same SQLite file and finishes the run.
import { appendFileSync } from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const phase = process.argv[2];
const log = (s) => { console.log(`[${phase} pid=${process.pid}] ${s}`); appendFileSync("side-effects.log", `${phase}: ${s}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const m = faux.getModel();
// Model script: turn 1 calls both tools; turn 2 answers.
faux.setResponses(
  phase === "crash"
    ? [fauxAssistantMessage([fauxToolCall("search_linear", { q: "flaky" }), fauxToolCall("post_slack", { text: "deploying" })], { stopReason: "toolUse" })]
    : [fauxAssistantMessage("All done after resume.")],
);

const searchLinear = defineTool({
  name: "search_linear", description: "read-only search", parameters: Type.Object({ q: Type.String() }),
  replay: "safe",
  execute: async (args) => { log(`search_linear START ${args.q}`); await sleep(4000); log("search_linear END"); return { content: [{ type: "text", text: "3 issues" }] }; },
});
const postSlack = defineTool({
  name: "post_slack", description: "side effect", parameters: Type.Object({ text: Type.String() }),
  // no replay => never re-executed after a crash
  execute: async (args) => { log(`post_slack START ${args.text}`); await sleep(4000); log("post_slack END"); return { content: [{ type: "text", text: "posted" }] }; },
});
const registry = createRegistry();
const Work = defineExtension({ name: "work", tools: [searchLinear, postSlack] });
registry.install(Work);

const harness = await Harness.open(await openNodeSqliteStorage("./agent.sqlite"), { models, registry }, ctx);
const root = await harness.root(ctx, { agent: { model: { provider: m.provider, modelId: m.id }, extensions: [Work] } });
const job = { type: "input", content: "triage the flaky test", requestId: "job-42" };

if (phase === "crash") {
  await root.submit(job, ctx);
  log("submitted job-42, waiting (will be killed)");
  await sleep(60_000);
} else {
  harness.resume();
  const sub = await root.submit(job, ctx); // same requestId => same submission, not a new one
  const settled = await sub.wait(ctx);
  log(`submission ${sub.id} settled: status=${settled.status}`);
  const page = await root.commit((tx) => tx.scanEntries({ conversationId: root.id }, 100), ctx);
  for (const e of page.items) {
    const parts = (e.model ?? []).flatMap((x) => (x.content && Array.isArray(x.content) ? x.content : [x]))
      .map((c) => c.type === "text" ? `text:${JSON.stringify(c.text).slice(0, 140)}` : c.type === "toolCall" ? `toolCall:${c.name}` : c.type ?? (typeof c.content === "string" ? c.content.slice(0, 80) : ""));
    console.log(`  entry ${e.kind ?? e.type}: ${parts.join(" | ")}`);
  }
  console.log(`  faux model calls in this process: ${faux.state.callCount}`);
  await harness.close(ctx);
}
