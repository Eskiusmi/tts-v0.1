// 后台补货：让题池始终有存货，玩家每次都能拿到没做过的题。
//
// 关键点：生成和验证在**后台**跑，不在玩家的请求路径上。
// 玩家拿到的永远是已经过三关验证的题。所谓「每次都是新题」，
// 是靠提前囤货实现的，不是靠让玩家等。
//
// 两种跑法：
//   1. AUTO_GENERATE=1  在 web 进程里定时补货（简单，但和请求抢 CPU）
//   2. Render Cron Job  跑 `npm run generate -- 5`（推荐，互不干扰）
//
// Render 免费层 0.1 CPU，用第 1 种会让游戏明显变卡。免费层请用第 2 种，
// 或者干脆在本地生成好、把 pool.json 提交进仓库。

import { spawn } from "node:child_process";
import { poolSize } from "./pool.js";

const MIN = Number(process.env.POOL_MIN || 20);
const BATCH = Number(process.env.POOL_BATCH || 5);
const EVERY = Number(process.env.POOL_CHECK_MIN || 30) * 60 * 1000;

let running = false;

function topUp() {
  if (running) return;
  const have = poolSize();
  if (have >= MIN) return;

  running = true;
  console.log(`[pool] 存货 ${have} < ${MIN}，后台生成 ${BATCH} 道…`);

  // 独立进程跑，生成崩了不影响正在玩的人
  const child = spawn(process.execPath, ["generate.js", String(BATCH)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });
  child.stdout.on("data", (d) => process.stdout.write("[pool] " + d));
  child.stderr.on("data", (d) => process.stderr.write("[pool!] " + d));
  child.on("close", (code) => {
    running = false;
    console.log(`[pool] 生成结束 (exit ${code})。重启后新题才会载入。`);
  });
}

export function startTopUp() {
  if (process.env.AUTO_GENERATE !== "1") return;
  console.log(`[pool] 自动补货已开启：低于 ${MIN} 道时每 ${EVERY / 60000} 分钟生成 ${BATCH} 道。`);
  setTimeout(topUp, 60_000);              // 启动一分钟后先看一眼
  setInterval(topUp, EVERY).unref();
}
