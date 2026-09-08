// npm run calibrate [-- puzzleId] [-- runs]
//
// 拿 probes.js 里手工标注的问题去打真裁判，报告：
//   漏报  —— 该给 key 没给      → 判定偏紧
//   误报  —— 不该给 key 给了    → 判定偏松
//   通关误判 / 注入没挡住 / 同一问题多次跑结果不一致（方差）
//
// 每条探针都在全新 session 上跑，互不影响。
// 改完 prompt 或换了 JUDGE_MODEL 之后重跑，数字可比。
//
//   JUDGE_MODEL=claude-haiku-4-5-20251001 npm run calibrate

import { adjudicate, reportAuth, JUDGE_MODEL } from "./adjudicator.js";
import { byId } from "./puzzles.js";
import { PROBES } from "./probes.js";

const puzzleId = process.argv[2] || "xuanguan-tuoxie";
const RUNS = Number(process.argv[3] || 2);

const puzzle = byId(puzzleId);
const probes = PROBES[puzzleId];
if (!puzzle) { console.error(`没有 ${puzzleId} 这道题`); process.exit(1); }
if (!probes) { console.error(`probes.js 里没有 ${puzzleId} 的探针，先写探针`); process.exit(1); }

reportAuth();
console.log(`\n校准 ${puzzleId} · 裁判 ${JUDGE_MODEL} · 每条探针跑 ${RUNS} 次\n`);

const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const tally = { miss: 0, extra: 0, solvedWrong: 0, verdictWrong: 0, unstable: 0, total: 0 };
const rows = [];

for (const probe of probes) {
  const results = [];
  for (let i = 0; i < RUNS; i++) {
    const out = await adjudicate(puzzle, { hit: [], history: [] }, probe.q);
    results.push(out);
    process.stdout.write(".");
  }

  const r = results[0];
  const flags = [];

  if ("expect" in probe) {
    const missing = probe.expect.filter((k) => !r.keys.includes(k));
    const extra = r.keys.filter((k) => !probe.expect.includes(k));
    if (missing.length) { flags.push(`漏报 ${missing.join(",")}`); tally.miss++; }
    if (extra.length)   { flags.push(`误报 ${extra.join(",")}`);   tally.extra++; }
  }
  if ("solved" in probe && r.solved !== probe.solved) {
    flags.push(probe.solved ? "该通关没通关" : "误判通关");
    tally.solvedWrong++;
  }
  if ("verdict" in probe && r.verdict !== probe.verdict) {
    flags.push(`该判「${probe.verdict}」实判「${r.verdict}」`);
    tally.verdictWrong++;
  }
  if (r.degraded) flags.push("裁判降级");

  const stable = results.every((x) =>
    x.verdict === r.verdict && same(x.keys, r.keys) && x.solved === r.solved
  );
  if (!stable) { flags.push("不稳定"); tally.unstable++; }

  tally.total++;
  rows.push({
    q: probe.q.length > 26 ? probe.q.slice(0, 25) + "…" : probe.q,
    verdict: r.verdict,
    keys: r.keys.join(",") || "-",
    solved: r.solved ? "✓" : "",
    flags: flags.join("；") || "✓"
  });
}

console.log("\n");
const w = (s, n) => String(s).padEnd(n);
console.log(w("问题", 28) + w("判定", 8) + w("keys", 10) + w("通关", 5) + "结果");
console.log("─".repeat(78));
for (const row of rows) {
  console.log(w(row.q, 28) + w(row.verdict, 8) + w(row.keys, 10) + w(row.solved, 5) + row.flags);
}

console.log("\n" + "─".repeat(78));
console.log(`探针 ${tally.total} 条 · 漏报 ${tally.miss} · 误报 ${tally.extra} · 通关误判 ${tally.solvedWrong} · 判定错 ${tally.verdictWrong} · 不稳定 ${tally.unstable}`);

const lines = [];
if (tally.miss > tally.extra + 1)  lines.push("→ 偏紧：在 puzzles.js 每个 key 的 need 里补「以下问法算命中：…」");
if (tally.extra > tally.miss + 1)  lines.push("→ 偏松：收紧 adjudicator.js 里「想到」的定义——要求问题预设该认知，光提到相关词不算");
if (tally.solvedWrong)             lines.push("→ 通关判定有问题：检查 prompt「通关」段，考虑加「必须同时说出全部关键点」");
if (tally.verdictWrong)            lines.push("→ 注入或开放式问题没挡住：检查 prompt「安全」段");
if (tally.unstable > tally.total / 4) lines.push("→ 方差偏大：把 facts 写得更明确，或者试试另一个 JUDGE_MODEL");
if (!lines.length)                 lines.push("→ 判定在可接受范围。可以放心去生成题库了。");
console.log(lines.join("\n"));
