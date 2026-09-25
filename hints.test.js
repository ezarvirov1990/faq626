import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeHints, hintStale, HINT_MAX } from "./hints.js";

const at = "2026-09-25T10:00:00.000Z";
const h = (extra = {}) => ({ request: "Похудение", outcome: "Обещала подумать", next: "Уточнить вопросы", at, ...extra });

test("новые подсказки добавляются, старые по другим лидам сохраняются", () => {
  const res = mergeHints({ 1: h() }, { 2: h({ request: "Риски" }) });
  assert.deepEqual(Object.keys(res).sort(), ["1", "2"]);
  assert.equal(res[2].request, "Риски");
});

test("подсказка по тому же лиду заменяется", () => {
  const res = mergeHints({ 1: h() }, { 1: h({ next: "Позвонить" }) });
  assert.equal(res[1].next, "Позвонить");
});

test("null удаляет подсказку", () => {
  assert.deepEqual(mergeHints({ 1: h(), 2: h() }, { 1: null }), { 2: h() });
});

test("без даты — ставится текущая", () => {
  const { at: _, ...noAt } = h();
  const res = mergeHints({}, { 5: noAt }, Date.parse("2026-09-25T12:00:00Z"));
  assert.equal(res[5].at, "2026-09-25T12:00:00.000Z");
});

test("неверные данные отклоняются целиком", () => {
  assert.throws(() => mergeHints({}, { abc: h() }), /номер лида/);
  assert.throws(() => mergeHints({}, { 1: { request: "x" } }), /outcome/);
  assert.throws(() => mergeHints({}, { 1: h({ next: "x".repeat(HINT_MAX + 1) }) }), /длиннее/);
  assert.throws(() => mergeHints({}, { 1: h({ at: "вчера" }) }), /дата/);
  assert.throws(() => mergeHints({}, []), /объект/);
});

test("лишние поля не сохраняются", () => {
  const res = mergeHints({}, { 1: h({ phone: "+7..." }) });
  assert.deepEqual(Object.keys(res[1]).sort(), ["at", "next", "outcome", "request"]);
});

test("устарела, если после подсказки в лиде была активность", () => {
  assert.equal(hintStale(h(), "2026-09-25T09:59:00.000Z"), false);
  assert.equal(hintStale(h(), "2026-09-25T10:05:00.000Z"), true);
  assert.equal(hintStale(h(), null), false);
});
