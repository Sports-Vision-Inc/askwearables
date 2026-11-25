// Measures the deployed planner's token usage per call, to apportion C-condition tokens in rows recorded before
// planner usage was logged separately.
import { planWithLlm } from "@askwearables/core";
import { chat, OPEN_MODELS } from "./llm.js";
import { makePeople, TODAY } from "./synth.js";
import { tasksFor } from "./tasks.js";
const llama = OPEN_MODELS.find((m) => m.id === "llama-3.3-70b")!;
const qs = makePeople().flatMap(tasksFor).map((t) => t.question).slice(0, 30);
const usage: { p: number; c: number }[] = [];
for (const q of qs) {
  await planWithLlm(async (_m, system, user) => {
    const r = await chat(llama, [{ role: "system", content: system }, { role: "user", content: user }], { max_tokens: 2500, temperature: 0 });
    usage.push({ p: r.usage.prompt, c: r.usage.completion });
    return r.message.content ?? "";
  }, [llama.model], q, TODAY, "UTC");
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(JSON.stringify({ calls: usage.length, mean_prompt: mean(usage.map((u) => u.p)), mean_completion: mean(usage.map((u) => u.c)) }));
