# 海龟汤 MVP

AI 主持的海龟汤。裁判层在服务端，汤底不下发。

## 跑起来

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start          # http://localhost:3000
```

`MODEL` 可选，默认 `claude-sonnet-5`。

## 部署到 Render

Build `npm install`，Start `npm start`，环境变量加 `ANTHROPIC_API_KEY`。
Render 会注入 `PORT`，代码已经读了。

## 结构

```
server.js           Express：路由、session、限流、对局日志
adjudicator.js      裁判层：prompt、解析、API 客户端（线上和离线验证共用）
puzzles.js          手写谜题（solution/facts/keys 永不出服务端）
pool.js             载入 generate.js 产出的 pool.json
generate.js         离线出题 + 三关验证
calibrate.js        校准 key 命中判定
probes.js           校准用的手工标注探针
check.js            诊断 key / workspace / 模型
test/               npm test，纯逻辑不打 API
public/index.html   前端，单文件无构建；文案全在 I18N 对象里
```

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 本地开发，读 .env，改代码自动重启 |
| `npm run check` | 确认 key 通不通 |
| `npm test` | 解析层单元测试 |
| `npm run calibrate` | 用探针测裁判判定准不准 |
| `npm run generate -- 5` | 离线生成 5 道通过验证的题 |
| `npm start` | Render 用，不读 .env |

## 接口

| 路由 | 作用 |
|---|---|
| `GET  /api/puzzles` | 谜题列表（只有 id / 汤色 / 格 / 难度） |
| `POST /api/start`   | 开局，返回 sessionId + 汤面 |
| `POST /api/ask`     | 裁定一问 |
| `POST /api/hint`    | 取下一条提示 |
| `POST /api/giveup`  | 投降，返回汤底 |

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✓ | |
| `ANTHROPIC_WORKSPACE_ID` | 跨 workspace 的 key 才要 | `wrkspc_` 开头 |
| `MODEL` | | 生成用，默认 `claude-sonnet-5` |
| `JUDGE_MODEL` | | 裁判用，默认同 MODEL。**建议换 Haiku**，见下 |
| `SOLVER_MODEL` | | 生成时模拟对局的提问方，默认 Haiku |
| `DEBUG_RAW` | | 设 1 打印模型原始输出，调完关掉 |

### 裁判模型的选择

裁判是「查表 + 判断」，每次调用 Sonnet 5 都会先自适应思考，你付 thinking token 的钱换来的判断可能并不比 Haiku 好。**用数据决定**：

```bash
npm run calibrate                                          # Sonnet 5
JUDGE_MODEL=claude-haiku-4-5-20251001 npm run calibrate    # Haiku
```

两个跑完比漏报 / 误报 / 不稳定三个数。Haiku 不明显差的话就用 Haiku，成本大概差一个数量级。

## 三条设计约束，改代码时别破坏

**1. 客户端不是可信边界。**
`solution`、`facts`、`keys` 的文本永远不出服务端。已命中的 key 和提问历史存在
服务端 session 里，不由客户端上报——否则玩家可以伪造进度直接触发通关。
`publicView()` 是唯一的下发白名单，加字段时经过它。

**2. 模型没有输出汤底的路径。**
不是靠 prompt 里写「不要泄露」，而是输出 schema 里根本没有那个字段，
`parseVerdict` 只提取 `verdict / keys / solved / note` 四项，`note` 还只在
「换个问法」时保留并截断到 60 字。prompt injection 就算部分成功也无处可去。

**3. 降级优于报错。**
模型返回非法 JSON 时重试一次，再失败就判「无关」。误判一次「无关」代价很小，
崩一次代价是整局。`ANTHROPIC_API_KEY` 填错时整个游戏仍然可玩（全判无关），
这是故意的。

## 已经做了的防护

- `/api/ask` 和 `/api/start` 都有按 IP 的令牌桶限流（20 次突发，6 秒回一次）
- session 总数上限 5000，超了淘汰最久没动的
- 原句重复提问直接回缓存，不打 API；降级的裁定不入历史、不缓存
- 基本安全头（nosniff / DENY frame / no-referrer）
- 每局结束一行 JSON 日志：`grep '"event":"finish"'` 就能看弃局率和平均问数

## 已知未做

- **session 和限流都存在内存里**，Render 重启或多实例就丢。上线前换 Redis / KV。
  两个 Map 都刻意写得接口很窄，换起来各二十行。
- **没有 Anthropic 消费上限。** 去 Console → Billing 设一个，那是最后一道保险。
- **谜题只有 3 题。** 见下。

## 下一步：先校准，再扩库

```bash
npm run calibrate
```

它拿 `probes.js` 里手工标注的 23 条问题去打真裁判，报漏报 / 误报 / 通关误判 /
注入没挡住 / 方差，末尾直接告诉你偏紧还是偏松、该改哪。每条探针跑两次，
同一问题两次结果不同会标「不稳定」——现在没有 temperature 了，方差要盯着。

**校准过了再 `npm run generate`。** 库先大后调，等于用错误的尺子量了一整批。

给新题写探针的原则：每个 key 至少一条正例 + 一条近似反例。反例是关键——
只测正例的话，一个「什么都给 key」的坏判定也能满分。

---

## 出题：离线生成 + 自动验证

```bash
npm run generate -- 5     # 生成到通过 5 题为止
```

题**不在玩家请求路径上生成**。生成器跑在你的机器上，产出的候选要过三关，
只有活下来的写进 `pool.json`，服务端启动时并入题库。

| 关卡 | 检查什么 | 成本 |
|---|---|---|
| 1. 结构 | 汤面 ≤60 字、facts ≥8 条且含否定事实、keys 3–5 | 免费 |
| 2. 题面诚实性 | 汤面每句在汤底成立时是否字面为真；汤底可否用是非问句推出 | 1 次调用 |
| 3. 模拟对局 | 让模型真的玩 12 问，看能否命中全部 key、无关率是否过高 | ~12 次调用 |

第 3 关是质量线第 3 条的自动化版本，也是最贵的一关，所以放最后——
前两关先把明显的废品筛掉。

**预期通过率不高。** 生成 4 题留 1 题是正常的，脚本按这个比例设了上限
（`MAX_TRIES = WANT * 4`）。没凑够就再跑一次。

### 反套路

不加约束的话模型会反复产出「死去的妻子 / 镜子 / 盲人 / 双胞胎」。
`generate.js` 里的 `LEVERS` 和 `SETTINGS` 每次随机组合，强制它换手法和场景。
如果你发现生成的题还是同质化，往这两个数组里加条目，比改 prompt 有效。

### 每题成本

一题算下来约 1 次生成 + 1 次审校 + 12 次裁定。模拟对局用便宜模型
（`SOLVER_MODEL`，默认 Haiku）——它只负责提问，不负责裁定。
按 4 题留 1 题算，收录一道题的实际成本是这个数字的四倍。先小批量跑，
确认质量再放量。

### 人还是要看

自动验证挡得住「题面撒谎」和「不可解」，挡不住「无聊」。
`pool.json` 是纯 JSON，收录后自己扫一遍，把没意思的删掉——
这一步没法自动化，但它比前三关快得多。
