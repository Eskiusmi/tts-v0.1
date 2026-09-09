import express from "express";
import crypto from "node:crypto";
import { PUZZLES, byId, publicView } from "./puzzles.js";
import { loadPool, pickFor, fingerprint, daily, poolSize } from "./pool.js";
import { startTopUp } from "./topup.js";
import { adjudicate, reportAuth } from "./adjudicator.js";
import { openSessionStore } from "./sessions.js";

reportAuth();
await loadPool();          // 把验证通过的生成题并入题库
startTopUp();              // AUTO_GENERATE=1 时后台补货
const sessions = await openSessionStore();   // Redis 或内存，见 sessions.js

const app = express();
// Render 在反向代理后面，不设这个拿到的 IP 全是代理的
app.set("trust proxy", 1);
app.use(express.json({ limit: "8kb" }));
app.use(express.static("public"));

app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store"
  });
  next();
});

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// 每次 /api/ask 都要花钱调 Claude API。没有这个，一个脚本能在几分钟内
// 刷掉你一个月的额度。按 IP 令牌桶：初始 20 次，每 6 秒回一次。
const BUCKET_MAX = 20;
const REFILL_MS = 6000;
const buckets = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: BUCKET_MAX, last: now }; buckets.set(ip, b); }
  b.tokens = Math.min(BUCKET_MAX, b.tokens + (now - b.last) / REFILL_MS);
  b.last = now;
  if (b.tokens < 1) {
    return res.status(429).json({ error: "too_many_requests" });
  }
  b.tokens -= 1;
  next();
}

setInterval(() => {
  const cutoff = Date.now() - 1000 * 60 * 30;
  for (const [ip, b] of buckets) if (b.last < cutoff) buckets.delete(ip);
}, 1000 * 60 * 10).unref();

// 每局结束打一行结构化日志。Render Logs 里 grep "finish" 就能看：
// 哪道题被弃得多、平均几问通关、提示用了几次。这是你迭代题库的唯一数据来源。
function logFinish(s, puzzle, outcome) {
  console.log(JSON.stringify({
    event: "finish", outcome, puzzle: puzzle.id,
    asked: s.history.length, hits: s.hit.length, totalKeys: puzzle.keys.length,
    hintsUsed: s.hintsUsed,
    verdicts: s.history.map((h) => h.verdict).join(""),
    at: new Date().toISOString()
  }));
}

/* ---------------- routes ---------------- */

app.get("/api/puzzles", (_req, res) => {
  res.json(PUZZLES.map((p) => ({
    id: p.id, broth: p.broth, genre: p.genre, difficulty: p.difficulty
  })));
});

app.post("/api/start", rateLimit, async (req, res) => {
  const { puzzleId, mode } = req.body || {};
  const fp = fingerprint(req);

  // daily —— 所有人今天同一道，分享才有意义
  // fresh —— 发一道这个玩家没做过的（默认）
  let puzzle, exhausted = false, remaining = null;
  if (mode === "daily" && !puzzleId) {
    puzzle = daily();
  } else {
    const picked = pickFor(fp, puzzleId && byId(puzzleId) ? puzzleId : null);
    // pickFor 走分享链接分支时直接返回题本身
    if (picked.puzzle) ({ puzzle, exhausted, remaining } = picked);
    else puzzle = picked;
  }

  if (await sessions.size() >= 5000) await sessions.evictOldest();
  const sid = crypto.randomUUID();
  await sessions.set(sid, {
    puzzleId: puzzle.id, hit: [], history: [], hintsUsed: 0, over: false
  });
  res.json({
    sessionId: sid,
    puzzle: publicView(puzzle),
    // 存货见底时告诉前端，让它换个说法而不是默默重复发老题
    exhausted, remaining, poolSize: poolSize()
  });
});

app.post("/api/ask", rateLimit, async (req, res) => {
  const { sessionId, question } = req.body || {};
  const s = sessionId ? await sessions.get(sessionId) : null;
  if (!s) return res.status(404).json({ error: "session_expired" });
  if (s.over) return res.status(409).json({ error: "game_over" });

  const q = String(question || "").trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: "empty_question" });

  const puzzle = byId(s.puzzleId);
  if (!puzzle) return res.status(404).json({ error: "session_expired" });

  // 原句重复提问：直接回之前的裁定，不再打 API。
  // 省钱，而且避免同一句话两次得到不同答案。
  const seen = s.history.find((h) => h.q === q);
  if (seen) {
    return res.json({
      verdict: seen.verdict, note: "", newKeys: 0, cached: true,
      hitKeys: s.hit.length, totalKeys: puzzle.keys.length,
      asked: s.history.length, solved: false, degraded: false
    });
  }

  const out = await adjudicate(puzzle, s, q);

  // 「换个问法」不计入提问数，也不推进进度。
  // 降级的裁定不是真答案，同样不入历史——否则重复提问会把假答案缓存住。
  if (out.verdict !== "换个问法" && !out.degraded) {
    s.history.push({ q, verdict: out.verdict });
    s.hit.push(...out.keys);
  }
  if (out.solved) {
    s.over = true;
    logFinish(s, puzzle, "solved");
  }
  await sessions.set(sessionId, s);

  res.json({
    verdict: out.verdict,
    note: out.note,
    newKeys: out.keys.length,
    hitKeys: s.hit.length,
    totalKeys: puzzle.keys.length,
    asked: s.history.length,
    solved: out.solved,
    degraded: out.degraded === true,
    // 只有通关才下发汤底
    solution: out.solved ? puzzle.solution : undefined
  });
});

app.post("/api/hint", async (req, res) => {
  const sid = req.body?.sessionId;
  const s = sid ? await sessions.get(sid) : null;
  if (!s) return res.status(404).json({ error: "session_expired" });
  const puzzle = byId(s.puzzleId);
  if (!puzzle) return res.status(404).json({ error: "session_expired" });
  if (s.hintsUsed >= puzzle.hints.length) {
    return res.status(409).json({ error: "no_more_hints" });
  }
  const hint = puzzle.hints[s.hintsUsed++];
  await sessions.set(sid, s);
  res.json({ hint, hintsUsed: s.hintsUsed, totalHints: puzzle.hints.length });
});

app.post("/api/giveup", async (req, res) => {
  const sid = req.body?.sessionId;
  const s = sid ? await sessions.get(sid) : null;
  if (!s) return res.status(404).json({ error: "session_expired" });
  const puzzle = byId(s.puzzleId);
  if (!puzzle) return res.status(404).json({ error: "session_expired" });
  s.over = true;
  await sessions.set(sid, s);
  logFinish(s, puzzle, "gaveup");
  res.json({ solution: puzzle.solution, asked: s.history.length, gaveUp: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`海龟汤 listening on ${PORT}`));
