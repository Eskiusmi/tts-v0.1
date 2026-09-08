import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import { PUZZLES } from "./puzzles.js";

const POOL_PATH = new URL("./pool.json", import.meta.url);

// 发过的题记在这里。玩家每次开局拿一道自己没做过的。
// 「每次新题」的新鲜感来自这里，不是来自实时生成——
// 实时生成等于把未验证的题直接送到玩家面前。
const servedBy = new Map();          // 玩家指纹 → Set(已做过的题 id)
const SERVED_TTL = 1000 * 60 * 60 * 24 * 30;

export function fingerprint(req) {
  // 没有账号系统，用 IP + UA 弱标识。够用来避免连着发重复题。
  const raw = (req.ip || "") + "|" + (req.get("user-agent") || "");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function pickFor(fp, wantId) {
  if (wantId) {
    const want = PUZZLES.find((p) => p.id === wantId);
    if (want) { markServed(fp, want.id); return want; }   // 分享链接优先，允许重做
  }
  const seen = servedBy.get(fp)?.ids ?? new Set();
  const fresh = PUZZLES.filter((p) => !seen.has(p.id));

  // 都做过了就从全库随机——总比拒绝开局好
  const from = fresh.length ? fresh : PUZZLES;
  const chosen = from[Math.floor(Math.random() * from.length)];
  markServed(fp, chosen.id);
  return { puzzle: chosen, exhausted: fresh.length === 0, remaining: Math.max(0, fresh.length - 1) };
}

function markServed(fp, id) {
  let rec = servedBy.get(fp);
  if (!rec) { rec = { ids: new Set(), touched: 0 }; servedBy.set(fp, rec); }
  rec.ids.add(id);
  rec.touched = Date.now();
}

setInterval(() => {
  const cutoff = Date.now() - SERVED_TTL;
  for (const [fp, rec] of servedBy) if (rec.touched < cutoff) servedBy.delete(fp);
}, 1000 * 60 * 60).unref();

// 每日一题：所有人今天拿到同一道，这是分享能成立的前提。
export function daily() {
  const day = Math.floor(Date.now() / 86400000);
  return PUZZLES[day % PUZZLES.length];
}

export const poolSize = () => PUZZLES.length;

// 生成的题经 generate.js 验证后写进 pool.json。
// 服务端只是读进来——它不知道也不关心这些题是怎么来的。
export async function loadPool() {
  try {
    const raw = await readFile(POOL_PATH, "utf8");
    const pool = JSON.parse(raw);
    if (!Array.isArray(pool)) throw new Error("pool.json 不是数组");

    const existing = new Set(PUZZLES.map((p) => p.id));
    let added = 0;
    for (const p of pool) {
      if (existing.has(p.id)) continue;
      // 服务端不信任文件内容，缺字段的直接跳过，不让它进到玩家面前
      if (!p.scene || !p.solution || !Array.isArray(p.facts) || !Array.isArray(p.keys)) {
        console.warn(`⚠ pool 里的 ${p.id ?? "(无 id)"} 字段不全，已跳过。`);
        continue;
      }
      PUZZLES.push(p);
      existing.add(p.id);
      added++;
    }
    console.log(`✓ 题池载入 ${added} 题，题库共 ${PUZZLES.length} 题。`);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("· 没有 pool.json，只用手写题库。跑 npm run generate 生成。");
    } else {
      console.error("⚠ 题池载入失败：", err.message, "— 继续用手写题库。");
    }
  }
}
