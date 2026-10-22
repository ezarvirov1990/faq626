import test from "node:test";
import assert from "node:assert/strict";
import { weekStart, weekStats, SUVVY_ID } from "./weekstats.js";

test("week starts on Monday 00:00 MSK", () => {
  assert.equal(weekStart(Date.parse("2026-10-22T12:00:00+03:00")), "2026-10-19"); // Thursday
  assert.equal(weekStart(Date.parse("2026-10-19T00:10:00+03:00")), "2026-10-19"); // Monday just after midnight MSK
  assert.equal(weekStart(Date.parse("2026-10-18T23:50:00+03:00")), "2026-10-12"); // Sunday night
});

test("per day: came, closed by kind, open at the end of the day; current owner; future days cut", () => {
  const owners = [{ id: 1, name: "A" }, { id: SUVVY_ID, name: "Савви" }];
  const L = (ID, o, created, status, closed, by = 7) => ({
    ID, ASSIGNED_BY_ID: String(o), CREATED_BY_ID: String(by), STATUS_ID: status, DATE_CREATE: created + "+03:00",
    STATUS_SEMANTIC_ID: status === "CONVERTED" ? "S" : ["JUNK", "2", "3", "4"].includes(status) ? "F" : "P",
    DATE_CLOSED: closed ? closed + "T00:00:00+03:00" : "",
  });
  const leads = [
    L("1", 1, "2026-10-19T10:00:00", "CONVERTED", "2026-10-20", SUVVY_ID), // came Mon via bot, qualified Tue
    L("2", 1, "2026-10-15T10:00:00", "JUNK", "2026-10-19"), // old lead, closed Mon
    L("3", 1, "2026-10-20T23:30:00", "IN_PROCESS"), // came Tue night, still open
    L("4", SUVVY_ID, "2026-10-21T09:00:00", "2", "2026-10-21"), // duplicate on the bot
    L("5", 9, "2026-10-19T09:00:00", "IN_PROCESS"), // other owner — ignored
    L("3", 1, "2026-10-20T23:30:00", "IN_PROCESS"), // same lead from another list — counted once
  ];
  const s = weekStats({ from: "2026-10-19", now: Date.parse("2026-10-21T15:00:00+03:00"), owners, leads });
  assert.deepEqual(s.days, ["2026-10-19", "2026-10-20", "2026-10-21"]);
  const a = s.cells["1"];
  assert.deepEqual(a["2026-10-19"], { came: 1, viaBot: 1, qual: 0, bad: 1, work: 1 });
  assert.deepEqual(a["2026-10-20"], { came: 1, viaBot: 0, qual: 1, bad: 0, work: 1 });
  assert.equal(a["2026-10-21"].work, 1);
  assert.equal(s.cells[String(SUVVY_ID)], undefined); // duplicates are not analysed
  assert.equal(s.cells["9"], undefined);
  const x = weekStats({ from: "2026-10-19", now: Date.parse("2026-10-21T15:00:00+03:00"), owners, leads, exclude: [1] });
  assert.equal(x.cells["1"]["2026-10-19"].came, 0);
});
