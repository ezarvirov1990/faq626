import { test } from "node:test";
import assert from "node:assert/strict";
import { channelName } from "./collector.js";

test("название канала без префикса Wazzup", () => {
  assert.equal(channelName("WAZZUP: Instagram"), "Instagram");
  assert.equal(channelName("ВКонтакте"), "ВКонтакте");
  assert.equal(channelName(""), "Чат");
  assert.equal(channelName(undefined), "Чат");
});
