#!/usr/bin/env bun
import { readFileSync } from "node:fs";

const reqs = [];
const names = new Map();
for (const line of readFileSync(process.argv[2], "utf8").split("\n")) {
  if (!line) continue;
  const r = JSON.parse(line);
  if (r.isSidechain) continue;
  if (r.type === "assistant") {
    const m = r.message;
    const u = m.usage ?? {};
    if (reqs.at(-1)?.id !== m.id) {
      const ctx =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
      reqs.push({ id: m.id, results: [], out: 0, ctx });
    }
    reqs.at(-1).out = Math.max(reqs.at(-1).out, u.output_tokens ?? 0);
    for (const c of m.content ?? []) {
      if (c.type !== "tool_use") continue;
      const key = String(c.input.command ?? c.input.file_path ?? c.input.skill ?? "");
      names.set(c.id, [c.name, key.slice(0, 160).replace(/[\n\t]/g, " ")]);
    }
  } else if (r.type === "user" && reqs.length && Array.isArray(r.message.content)) {
    for (const b of r.message.content)
      if (b.type === "tool_result") reqs.at(-1).results.push(b.tool_use_id);
  }
}

for (let i = 0; i + 1 < reqs.length; i++) {
  const a = reqs[i];
  const added = reqs[i + 1].ctx - a.ctx - a.out;
  const share = Math.round(added / Math.max(a.results.length, 1));
  for (const t of a.results.length ? a.results : [null]) {
    const [name, key] = names.get(t) ?? ["(non-tool)", ""];
    console.log(`${share}\t${name}\t${key}`);
  }
}
