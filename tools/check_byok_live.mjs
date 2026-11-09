// Opt-in live probe. Reads the local key without printing, persisting or packaging it.
// Saving checks one small inference; --infer adds three bounded sample calls.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
require(path.join(root, "extension/byok-contract.js"));
require(path.join(root, "extension/byok-client.js"));
let key = process.env.TYPESAFE_API_KEY;
if (!key && fs.existsSync(path.join(root, "backend/.env"))) {
  for (const line of fs.readFileSync(path.join(root, "backend/.env"), "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/);
    if (match) {
      key = match[1];
      if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
    }
  }
}
if (!key) throw new Error("Set TYPESAFE_API_KEY locally or configure backend/.env; never pass a key as a command argument.");
function area() {
  const data = {};
  return { setAccessLevel: async () => {}, get: async k => ({ [k]: data[k] }),
    set: async values => Object.assign(data, values), remove: async k => { delete data[k]; } };
}
let providerCalls = 0;
const client = FocusFeedByok.create({ session: area(), local: area(), onBoundary: async () => {},
  fetch: async (url, init) => {
    providerCalls++;
    const response = await fetch(url, init);
    if (url.endsWith("/models")) {
      const body = await response.clone().json().catch(() => null);
      const entries = Array.isArray(body) ? body : body?.models || body?.data || [];
      console.log(JSON.stringify({ stage: "model-catalog", httpStatus: response.status, shape: Array.isArray(body) ? "array" : typeof body,
        fields: body && !Array.isArray(body) ? Object.keys(body) : [],
        models: Array.isArray(entries) ? entries.map(m => typeof m === "string" ? m : m?.name || m?.id).filter(m => typeof m === "string" && /^jev-[a-z0-9.-]+$/.test(m)) : [] }));
    }
    return response;
  } });
try {
  if (process.argv.includes("--probe-model")) {
    const response = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: FocusFeedByokContract.model, state: "2 is an even number.", questions: { key_check: { type: "noul", instructions: "Does the statement say that 2 is even?" } } }) });
    key = ""; const body = await response.json().catch(() => ({}));
    console.log(JSON.stringify({ stage: "direct-pinned-model-probe", httpStatus: response.status,
      model: /^jev-[a-z0-9.-]+$/.test(body.model || "") ? body.model : null,
      validJudgment: body.answers?.key_check?.type === "noul" && Number.isFinite(body.answers?.key_check?.noul) }));
    process.exit(response.ok ? 0 : 1);
  }
  const status = await client.save(key); key = "";
  console.log(JSON.stringify({ stage: "save-and-check", success: status.keyConfigured }));
  if (process.argv.includes("--infer")) {
    const checked = await client.request("/objectives/classify", { body: JSON.stringify({ requestId: "live-byok-topic-check", mode: "general", objectives: ["movie reviews"] }) });
    const topic = checked.objectives[0];
    if (!topic.validatedObjective || topic.validatedObjective.text !== "movie reviews") throw new Error("Topic validation failed");
    console.log(JSON.stringify({ stage: "topic-validation", status: topic.status, model: checked.classifier.model }));
    const profile = { id: "general", version: 1, mode: "general", objectives: [topic.validatedObjective] };
    const videos = await client.request("/classify", { body: JSON.stringify({ requestId: "live-byok-video-check", profile,
      videos: [{ videoId: "sample-review", title: "Interstellar movie review: story, performances and my rating", channel: "Movie Reviews" },
               { videoId: "sample-science", title: "The physics of black holes explained: an astronomy lesson", channel: "Science Classroom" }] }) });
    if (videos.assessments[0].outcome !== "match" || videos.assessments[1].outcome !== "no_match") throw new Error("Sample review/science distinction failed");
    console.log(JSON.stringify({ stage: "video-filtering", assessments: videos.assessments.map(a => ({ id: a.videoId, outcome: a.outcome })), model: videos.classifier.model }));
    const channel = await client.request("/channels/classify", { body: JSON.stringify({ requestId: "live-byok-channel-check", profile,
      channel: { channelId: "UCsample123456", title: "Movie Review Channel", knownTopics: ["Movie reviews"], uploads: [] } }) });
    if (!channel.matches[0].blockChannel) throw new Error("Sample channel judgment failed");
    console.log(JSON.stringify({ stage: "channel-filtering", blockChannel: channel.matches[0].blockChannel, model: channel.classifier.model }));
  }
  await client.remove();
  console.log(JSON.stringify({ stage: "complete", providerCalls, keyRemoved: true }));
} catch (error) {
  key = "";
  console.error(JSON.stringify({ stage: "failed", code: error.code || "live_check_failed", providerCalls }));
  process.exitCode = 1;
}
