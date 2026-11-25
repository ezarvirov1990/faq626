import { test } from "node:test";
import assert from "node:assert/strict";
import { activityByHour, paymentsByHour, excludedPromo } from "./hourly.js";

test("outgoing calls and messages land in MSK hours; incoming calls, other kinds and other people are skipped", () => {
  const at = (hhmm) => Date.parse("2026-11-24T" + hhmm + ":00+03:00");
  const ev = [
    { managerId: 1, kind: "msg", at: at("09:05") }, { managerId: 1, kind: "msg", at: at("09:55") },
    { managerId: 1, kind: "call", outgoing: true, at: at("10:00") }, { managerId: 1, kind: "call", outgoing: false, at: at("10:10") },
    { managerId: 1, kind: "move", at: at("10:20") }, { managerId: 2, kind: "msg", at: at("23:59") }, { managerId: 9, kind: "msg", at: at("11:00") },
  ];
  const r = activityByHour(ev, [1, 2]);
  assert.equal(r[1].msgs[9], 2);
  assert.equal(r[1].calls[10], 1);
  assert.equal(r[1].calls.reduce((a, x) => a + x), 1);
  assert.equal(r[2].msgs[23], 1);
  assert.equal(r[9], undefined);
});

test("payments by MSK hour, a deal paid twice in a day counts once", () => {
  const moves = [{ OWNER_ID: "5", CREATED_TIME: "2026-11-24T14:10:00+03:00" }, { OWNER_ID: "6", CREATED_TIME: "2026-11-24T00:30:00+03:00" }, { OWNER_ID: "5", CREATED_TIME: "2026-11-24T16:00:00+03:00" }];
  const r = paymentsByHour(moves, { 5: { owner: 77, sum: 12000 } });
  assert.deepEqual(r, [{ h: 0, deal: 6, owner: null, sum: 0 }, { h: 14, deal: 5, owner: 77, sum: 12000 }]);
});

test("partner promo codes are recognised, others are not; such deals drop out of payments", () => {
  for (const c of ["BKL50050", "LYH250100", "PRTN-BNJ6T", "KRF10050", "POG500100", "SEN10050", "BKL500100", "ZEN50050", " TRO25050 "]) assert.ok(excludedPromo(c), c);
  for (const c of ["QUPL", "GEN3", "POV20", "PROMIK_20", "check", "SL-0ULC7-8EPHGZE", "", null]) assert.ok(!excludedPromo(c), String(c));
  const r = paymentsByHour([{ OWNER_ID: "1", CREATED_TIME: "2026-11-24T10:00:00+03:00" }, { OWNER_ID: "2", CREATED_TIME: "2026-11-24T11:00:00+03:00" }], { 1: { owner: 5, sum: 100, promo: true }, 2: { owner: 5, sum: 200 } });
  assert.deepEqual(r.map((p) => p.deal), [2]);
});
test("Wazzup template echoes sent under several managers or 3+ times a day are not counted", () => {
  const at = Date.parse("2026-11-24T12:00:00+03:00");
  const ev = [
    { managerId: 1, kind: "msg", at, tpl: "sale" }, { managerId: 2, kind: "msg", at, tpl: "sale" },
    { managerId: 1, kind: "msg", at, tpl: "x" }, { managerId: 1, kind: "msg", at, tpl: "x" }, { managerId: 1, kind: "msg", at, tpl: "x" },
    { managerId: 1, kind: "msg", at, tpl: "own" }, { managerId: 1, kind: "msg", at },
  ];
  assert.equal(activityByHour(ev, [1, 2])[1].msgs[12], 2);
});