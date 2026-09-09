// Session 存储。设了 REDIS_URL 就用 Redis，否则用内存。
//
// 为什么必须有这一层：Render 每次部署都重启进程，内存里的 session 全部清空，
// 玩家正玩着突然「这局已过期」。免费层休眠、以后开多实例，也都是同一个问题。
// Redis 是唯一让 session 活过进程生命周期的办法。
//
// Render 上建一个免费的 Key Value（25MB，对这点数据绰绰有余），
// 把它的 Internal URL 填进 REDIS_URL 即可。本地开发不用设，自动走内存。

const TTL_SEC = 60 * 60 * 3;

function memoryStore() {
  const map = new Map();
  setInterval(() => {
    const cutoff = Date.now() - TTL_SEC * 1000;
    for (const [k, v] of map) if (v.touched < cutoff) map.delete(k);
  }, 1000 * 60 * 10).unref();

  return {
    kind: "memory",
    async get(id) { return map.get(id) ?? null; },
    async set(id, s) { s.touched = Date.now(); map.set(id, s); },
    async size() { return map.size; },
    async evictOldest() {
      let oldest = null, at = Infinity;
      for (const [k, v] of map) if (v.touched < at) { oldest = k; at = v.touched; }
      if (oldest) map.delete(oldest);
    }
  };
}

async function redisStore(url) {
  const { createClient } = await import("redis");
  const client = createClient({
    url,
    socket: {
      connectTimeout: 3000,
      // 启动时连不上就放弃，退回内存；不要无限重试把服务卡死
      reconnectStrategy: (retries) => (retries > 2 ? new Error("redis unreachable") : 300)
    }
  });
  client.on("error", (e) => console.error("[redis]", e.message));

  await Promise.race([
    client.connect(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("connect timeout")), 5000))
  ]);
  const key = (id) => `hg:s:${id}`;

  return {
    kind: "redis",
    async get(id) {
      const raw = await client.get(key(id));
      return raw ? JSON.parse(raw) : null;
    },
    async set(id, s) {
      s.touched = Date.now();
      // 每次写都续期，活跃的局不会中途过期
      await client.set(key(id), JSON.stringify(s), { EX: TTL_SEC });
    },
    async size() { return 0; },        // Redis 自己按 TTL 清，不需要手动淘汰
    async evictOldest() {}
  };
}

export async function openSessionStore() {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log("· session 存在内存里。部署重启会清空，上线前设 REDIS_URL。");
    return memoryStore();
  }
  try {
    const s = await redisStore(url);
    console.log("✓ session 存在 Redis。");
    return s;
  } catch (err) {
    console.error("⚠ Redis 连不上：", err.message, "— 退回内存。");
    return memoryStore();
  }
}
