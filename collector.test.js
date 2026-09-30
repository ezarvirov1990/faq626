import test from "node:test";
import assert from "node:assert/strict";
import { parseDealPipelines, skipStageIds, mergeDealPipelines } from "./collector.js";

const pipe = (id, open, slow = false) => ({ id, title: "P" + id, thresholdHours: 720, totalOpen: Object.values(open).reduce((a, n) => a + n, 0), openByManager: open, slow });
const item = (id, pipeline, silentSince) => ({ id, pipeline, silentSince, managerId: 1 });

test("fast collection carries slow pipelines over from the previous snapshot", () => {
  const prev = { views: { deals: {
    pipelines: [pipe(27, { 1: 5 }), pipe(65, { 9: 7 }, true)],
    items: [item(1, 27, "2026-08-01"), item(2, 65, "2026-07-01")],
    extraManagers: [{ id: 9, name: "Юлия" }],
  } } };
  const fresh = { views: { leads: { items: [] }, deals: {
    title: "В2С", pipelines: [pipe(27, { 1: 4 })], openByManager: { 1: 4 }, totalOpen: 4, items: [item(3, 27, "2026-08-15")], extraManagers: [],
  } } };
  const d = mergeDealPipelines(fresh, prev).views.deals;
  assert.deepEqual(d.pipelines.map((p) => p.id), [27, 65]);
  assert.deepEqual(d.items.map((x) => x.id), [2, 3]); // old main-pipeline item 1 is replaced by the fresh ones
  assert.deepEqual(d.openByManager, { 1: 4, 9: 7 });
  assert.equal(d.totalOpen, 11);
  assert.deepEqual(d.extraManagers.map((m) => m.id), [9]);
});

test("fast collection keeps today's feed events of other pipelines' people", () => {
  const today = Date.parse("2026-09-30T00:00:00+03:00");
  const ev = (key, managerId, at) => ({ key, managerId, at, kind: "msg" });
  const prev = {
    views: { deals: { pipelines: [pipe(27, {}), pipe(65, {}, true)], items: [], extraManagers: [{ id: 9, name: "Юлия" }] } },
    activity: { since: new Date(today).toISOString(), events: [ev("msg:1", 9, today + 1e3), ev("msg:2", 1, today + 2e3), ev("msg:0", 9, today - 1e3)] },
  };
  const fresh = {
    views: { deals: { pipelines: [pipe(27, {})], items: [], extraManagers: [{ id: 9, name: "Юлия" }] } },
    activity: { since: new Date(today).toISOString(), events: [ev("msg:3", 1, today + 3e3)] },
  };
  const keys = mergeDealPipelines(fresh, prev).activity.events.map((e) => e.key).sort();
  assert.deepEqual(keys, ["msg:1", "msg:3"]); // main-group events come fresh; yesterday's are dropped
});

test("nothing to carry over: fresh snapshot stays as is", () => {
  const fresh = { views: { deals: { pipelines: [pipe(27, {}), pipe(65, {}, true)], items: [] } } };
  assert.equal(mergeDealPipelines(fresh, { views: { deals: { pipelines: [pipe(27, {})], items: [] } } }), fresh);
  assert.equal(mergeDealPipelines(fresh, null), fresh);
});

test("pipelines by default: main B2C sales plus upsell and GenConf for the upsell group", () => {
  const p = parseDealPipelines({});
  assert.deepEqual(p.map((x) => [x.id, x.days]), [[27, 30], [65, 14], [53, 30]]);
  assert.equal(p[0].departments, undefined); // main pipeline uses DEPARTMENTS
  assert.deepEqual(p[1].departments, [206]);
  assert.ok(p[1].excludeUsers.includes(77)); // the head isn't listed in upsell pipelines
});

test("main pipeline still follows DEAL_CATEGORY_ID and DEAL_THRESHOLD_DAYS", () => {
  const [main] = parseDealPipelines({ DEAL_CATEGORY_ID: "41", DEAL_THRESHOLD_DAYS: "20" });
  assert.deepEqual([main.id, main.days], [41, 20]);
});

test("DEAL_PIPELINES replaces the defaults", () => {
  assert.deepEqual(parseDealPipelines({ DEAL_PIPELINES: '[{"id":1,"days":5}]' }), [{ id: 1, days: 5 }]);
});

test("GenConf stages after the ticket purchase are skipped", () => {
  const stages = {
    "C53:NEW": "Новая заявка", "C53:PREPARATION": "Готов оплачивать",
    "C53:1": "Купили билет оффлайн", "C53:2": "Купили билет онлайн", "C53:3": "Подтвердили визит", "C53:4": "Посетил мероприятие",
  };
  const genconf = parseDealPipelines({}).find((x) => x.id === 53);
  assert.deepEqual([...skipStageIds(stages, genconf.skipStages)].sort(), ["C53:1", "C53:2", "C53:3", "C53:4"]);
  assert.equal(skipStageIds(stages).size, 0);
});
