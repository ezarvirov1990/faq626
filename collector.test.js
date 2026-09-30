import test from "node:test";
import assert from "node:assert/strict";
import { parseDealPipelines, skipStageIds } from "./collector.js";

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
