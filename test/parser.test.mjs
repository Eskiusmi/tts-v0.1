// npm test —— 纯逻辑，不打 API
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ANTHROPIC_API_KEY ||= "test";
const { parseVerdict, normalizeVerdict, extractText } = await import("../adjudicator.js");

const puzzle = { keys: [{ id: "k1" }, { id: "k2" }, { id: "k3" }] };
const parse = (raw, hit = []) => parseVerdict(raw, puzzle, hit);

test("严格 JSON", () => {
  assert.deepEqual(parse('{"verdict":"是","keys":[],"solved":false,"note":""}'),
    { verdict: "是", keys: [], solved: false, note: "" });
});

test("自然写法归一化", () => {
  for (const [raw, want] of [["不是", "否"], ["是的", "是"], ["无关紧要", "无关"],
                             ["no", "否"], ["请换个问法", "换个问法"], ["无关。", "无关"]]) {
    assert.equal(normalizeVerdict(raw), want, raw);
  }
  assert.equal(normalizeVerdict("也许"), null);
});

test("剥掉代码块和前言", () => {
  assert.equal(parse("```json\n{\"verdict\":\"否\",\"keys\":[]}\n```").verdict, "否");
  assert.equal(parse("好的，裁定如下：{\"verdict\":\"是\",\"keys\":[]}").verdict, "是");
});

test("伪造的 key 被丢弃，已命中的不重复", () => {
  assert.deepEqual(parse('{"verdict":"是","keys":["k9","k1","k2"]}', ["k2"]).keys, ["k1"]);
});

test("note 只在换个问法时保留，且截断", () => {
  assert.equal(parse('{"verdict":"是","note":"汤底是保洁"}').note, "");
  const long = "x".repeat(200);
  assert.equal(parse(`{"verdict":"换个问法","note":"${long}"}`).note.length, 60);
});

test("solved 接受字符串 true", () => {
  assert.equal(parse('{"verdict":"是","solved":"true"}').solved, true);
  assert.equal(parse('{"verdict":"是","solved":"false"}').solved, false);
});

test("没有 JSON 就抛错", () => {
  assert.throws(() => parse("我不能回答"), /no json object/);
});

test("extractText 区分截断 / 拒绝 / 正常", () => {
  assert.equal(extractText({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }, "t"), "ok");
  assert.throws(() => extractText({ content: [{ type: "thinking" }], stop_reason: "max_tokens" }, "t"), /max_tokens/);
  assert.throws(() => extractText({ content: [], stop_reason: "refusal" }, "t"), /拒绝/);
});
