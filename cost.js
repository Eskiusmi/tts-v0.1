// npm run cost
//
// 成本估算。所有假设都在下面，觉得不对就改数字重跑。
// 真实数字要看 Console → Usage，跑几十局之后对一下。

const PRICE = {                       // 每百万 token，美元
  "claude-sonnet-5":            { in: 3,  out: 15 },   // 引入期 $2/$10 已于 8/31 到期，按标准价算
  "claude-opus-5":              { in: 5,  out: 25 },
  "claude-haiku-4-5-20251001":  { in: 1,  out: 5  }
};
const CACHE_READ = 0.10;              // 缓存命中按输入价 10%

// ---- 假设：改这里 ----
const A = {
  judgeIn:   2200,   // 裁判每次的输入：prompt + 汤面 + 汤底 + 11 条 facts + keys + 历史
  judgeOut:  500,    // 输出：自适应思考 + 60 token 的 JSON。思考是大头，且照常计费
  qPerGame:  15,     // 一局平均提问数

  genIn:     800,    // 生成一道题的输入
  genOut:    2500,   // 输出：整道题的 JSON + 思考
  critIn:    400,    // 审校输入
  critOut:   400,
  simTurns:  12,     // 模拟对局轮数
  solverIn:  500,    // 模拟提问方的输入
  solverOut: 300,
  passRate:  0.25    // 生成四道留一道
};

const cost = (model, tIn, tOut, cached = 0) => {
  const p = PRICE[model];
  const fresh = tIn * (1 - cached), hit = tIn * cached;
  return (fresh * p.in + hit * p.in * CACHE_READ + tOut * p.out) / 1e6;
};

function report(judge, cacheRate) {
  const solver = "claude-haiku-4-5-20251001";
  const gen = "claude-sonnet-5";      // 出题要创造力，不建议降级

  const perQ    = cost(judge, A.judgeIn, A.judgeOut, cacheRate);
  const perGame = perQ * A.qPerGame;

  const genCost  = cost(gen, A.genIn, A.genOut);
  const critCost = cost(gen, A.critIn, A.critOut);
  const simCost  = A.simTurns * (cost(solver, A.solverIn, A.solverOut) + perQ);
  const perCand  = genCost + critCost + simCost;
  const perKept  = perCand / A.passRate;

  return { judge, cacheRate, perQ, perGame, perCand, perKept };
}

const scenarios = [
  report("claude-sonnet-5", 0),
  report("claude-sonnet-5", 0.85),
  report("claude-haiku-4-5-20251001", 0),
  report("claude-haiku-4-5-20251001", 0.85)
];

const usd = (n) => "$" + n.toFixed(n < 1 ? 4 : 2);
const pad = (s, n) => String(s).padEnd(n);

console.log("\n单位成本（裁判模型 × 是否缓存系统提示）\n");
console.log(pad("裁判", 26) + pad("缓存", 8) + pad("每问", 11) + pad("每局", 11) + "每收录一题");
console.log("─".repeat(72));
for (const s of scenarios) {
  console.log(
    pad(s.judge.replace("-20251001", ""), 26) +
    pad(s.cacheRate ? "开" : "关", 8) +
    pad(usd(s.perQ), 11) +
    pad(usd(s.perGame), 11) +
    usd(s.perKept)
  );
}

console.log("\n\n场景推演（题池 200 道，一次性建好）\n");
const players = [10, 100, 1000, 10000];
console.log(pad("玩家数", 10) + pad("对局数", 10) +
  scenarios.map(s => pad(s.judge.includes("haiku") ? "Haiku" : "Sonnet", 9) +
    pad(s.cacheRate ? "+缓存" : "", 8)).join(""));
console.log("─".repeat(76));
for (const n of players) {
  const games = n * 3;               // 假设人均玩 3 局
  console.log(pad(n, 10) + pad(games, 10) +
    scenarios.map(s => pad(usd(s.perGame * games), 17)).join(""));
}

console.log("\n一次性建 200 道题的成本：");
for (const s of scenarios) {
  console.log(`  ${pad(s.judge.replace("-20251001",""), 26)}${pad(s.cacheRate?"+缓存":"", 8)}${usd(s.perKept * 200)}`);
}

console.log(`
说明
· 每收录一题的成本已经含了扔掉的三道（通过率 ${A.passRate * 100}%）。
· 内容是一次性投入，对局是随用户数线性增长的——后者才是会失控的那个。
· 缓存假设 85%：一局里系统提示（汤面+汤底+facts）每次都一样，
  只有历史在变。缓存命中按输入价 10% 计费，这是最大的一根杠杆。
· 生成用 Sonnet 5 没降级——出题要创造力，那一步省不出多少钱。
· 出题可以走 Batch API 再打五折（离线任务，不在乎延迟）。
`);
