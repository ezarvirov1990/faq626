import { test } from "node:test";
import assert from "node:assert/strict";
import { corpRules, corpContactNote, CORP_STAGES, collectCorp } from "./corp.js";

const DAY = 864e5;
const HOUR = 3600e3;
const now = Date.parse("2026-11-06T12:00:00+03:00");
const st = Object.fromEntries(CORP_STAGES.map((s) => [s.key, s.id]));
const fresh = [{ at: now - 2 * DAY, text: "Звонок ЛПР в пятницу" }];
const deal = (o) => ({ id: 1, title: "ООО Ромашка", owner: 306916, amount: 0, createdAt: now - 100 * DAY, movedAt: now - 5 * DAY,
  tasks: [now + 3 * DAY], notes: fresh, contacts: [], ...o });
const codes = (r) => r.rules.map((x) => x.code).sort();

test("unknown stage → null", () => {
  assert.equal(corpRules(deal({ stageId: "C41:WON" }), now), null);
});

test("База на проработку: more than 2 months since creation; no task or comment rules", () => {
  assert.deepEqual(codes(corpRules(deal({ stageId: st.base, createdAt: now - 61 * DAY, tasks: [], notes: [] }), now)), ["old"]);
  assert.deepEqual(codes(corpRules(deal({ stageId: st.base, createdAt: now - 59 * DAY, tasks: [], notes: [] }), now)), []);
});

test("Новый клиент: more than a day on the stage", () => {
  assert.deepEqual(codes(corpRules(deal({ stageId: st.new, movedAt: now - 25 * HOUR, tasks: [], notes: [] }), now)), ["notaken"]);
  assert.deepEqual(codes(corpRules(deal({ stageId: st.new, movedAt: now - 23 * HOUR, tasks: [], notes: [] }), now)), []);
});

test("task: none, overdue, without a deadline, due today", () => {
  const r = (tasks) => corpRules(deal({ stageId: st.work, tasks }), now);
  assert.deepEqual(codes(r([])), ["notask"]);
  assert.equal(r([]).task.state, "none");
  assert.deepEqual(codes(r([now - 2 * DAY])), ["taskdue"]);
  assert.equal(r([now - 2 * DAY]).task.state, "due");
  assert.deepEqual(codes(r([null])), ["notask"]);
  assert.match(r([null]).rules[0].text, /нет срока/);
  const today = Date.parse("2026-11-06T09:00:00+03:00");
  assert.deepEqual(codes(r([today])), []);
  assert.equal(r([now + 5 * DAY, now + DAY]).task.next, now + DAY);
});

test("Взят в работу: 30 days max even with a task; middle stages allow it with an actual task", () => {
  assert.deepEqual(codes(corpRules(deal({ stageId: st.work, movedAt: now - 31 * DAY }), now)), ["over"]);
  assert.deepEqual(codes(corpRules(deal({ stageId: st.lpr, movedAt: now - 31 * DAY }), now)), []);
  assert.deepEqual(codes(corpRules(deal({ stageId: st.kp, movedAt: now - 31 * DAY, tasks: [] }), now)), ["notask", "over"]);
  assert.deepEqual(codes(corpRules(deal({ stageId: st.signed, movedAt: now - 29 * DAY, tasks: [] }), now)), ["notask"]);
});

test("comment: fresh within 30 days", () => {
  const r = (notes) => codes(corpRules(deal({ stageId: st.terms, notes }), now));
  assert.deepEqual(r([{ at: now - 29 * DAY, text: "x" }]), []);
  assert.deepEqual(r([{ at: now - 31 * DAY, text: "x" }]), ["nocomment"]);
  assert.deepEqual(r([]), ["nocomment"]);
  assert.equal(corpRules(deal({ stageId: st.terms, notes: [{ at: now - 40 * DAY, text: "a" }, { at: now - 31 * DAY, text: "b" }] }), now).lastNote, now - 31 * DAY);
});

test("Счет выставлен: no time limit, still task and comment", () => {
  assert.deepEqual(codes(corpRules(deal({ stageId: st.invoice, movedAt: now - 90 * DAY }), now)), []);
  assert.deepEqual(codes(corpRules(deal({ stageId: st.invoice, movedAt: now - 90 * DAY, tasks: [], notes: [] }), now)), ["nocomment", "notask"]);
});

test("bases: monthly contact — Bitrix contact or a note saying contact happened", () => {
  const r = (o) => corpRules(deal({ stageId: st.partners, movedAt: now - 200 * DAY, ...o }), now);
  assert.deepEqual(codes(r({ contacts: [{ at: now - 10 * DAY, kind: "call" }] })), []);
  assert.deepEqual(codes(r({ contacts: [{ at: now - 40 * DAY, kind: "call" }] })), ["nocontact"]);
  const viaNote = r({ notes: [{ at: now - 5 * DAY, text: "Созвонились, обсудили план на ноябрь" }] });
  assert.deepEqual(codes(viaNote), []);
  assert.deepEqual(viaNote.lastContact, { at: now - 5 * DAY, kind: "note" });
  assert.deepEqual(codes(r({ notes: [{ at: now - 5 * DAY, text: "Не отвечает, недозвон" }] })), ["nocontact"]);
  assert.deepEqual(codes(corpRules(deal({ stageId: st.agents, tasks: [], notes: [] }), now)), ["nocomment", "nocontact", "notask"]);
});

test("corpContactNote: «договор» alone is not contact", () => {
  assert.equal(corpContactNote("Отправил договор на подпись юристам"), false);
  assert.equal(corpContactNote("Созвонились с ЛПР"), true);
  assert.equal(corpContactNote("Встреча в офисе клиента, договорились о пилоте"), true);
  assert.equal(corpContactNote("Звонил — не берет трубку"), false);
});

test("collectCorp: team, deals, tasks, notes, contacts via the company", async () => {
  const calls = [];
  const deals = [
    { ID: "11", TITLE: "Альфа", STAGE_ID: st.work, ASSIGNED_BY_ID: "306916", DATE_CREATE: "2026-10-01T10:00:00+03:00", MOVED_TIME: "2026-10-20T10:00:00+03:00", OPPORTUNITY: "150000.00", CONTACT_ID: "0", COMPANY_ID: "0" },
    { ID: "12", TITLE: "Бета", STAGE_ID: st.partners, ASSIGNED_BY_ID: "181", DATE_CREATE: "2025-01-01T10:00:00+03:00", MOVED_TIME: "2025-03-01T10:00:00+03:00", OPPORTUNITY: "0", CONTACT_ID: "501", COMPANY_ID: "701" },
  ];
  const bx = {
    portal: "https://x.bitrix24.ru",
    async call(method, body) {
      calls.push(method);
      if (method === "user.get") return { result: [{ ID: "306916", NAME: "Светлана", LAST_NAME: "Камелина" }, { ID: "181", NAME: "Евгений", LAST_NAME: "Зарвиров" }] };
      if (method === "crm.deal.list") return { result: deals, total: 2 };
      if (method === "voximplant.statistic.get") return { result: [] };
      throw new Error("unexpected " + method);
    },
    async batch(cmds) {
      const out = {};
      for (const [k, q] of Object.entries(cmds)) {
        if (q.startsWith("crm.activity.list") && q.includes("CRM_TASKS_TASK")) out[k] = q.includes("start=0") ? [{ ID: "1", OWNER_ID: "11", DEADLINE: "2026-11-10T19:00:00+03:00" }] : [];
        else if (q.startsWith("crm.timeline.comment.list")) out[k] = q.includes("ENTITY_ID]=11") ? [{ CREATED: "2026-11-01T10:00:00+03:00", COMMENT: "План" }] : [];
        else if (q.startsWith("crm.activity.list") && q.includes("OWNER_TYPE_ID]=4")) out[k] = [{ ID: "9", OWNER_TYPE_ID: "4", OWNER_ID: "701", PROVIDER_ID: "CRM_EMAIL", CREATED: "2026-11-02T10:00:00+03:00", LAST_UPDATED: "2026-11-02T10:00:00+03:00", COMPLETED: "Y" }];
        else out[k] = [];
      }
      return { out, errors: 0 };
    },
  };
  const r = await collectCorp(bx, now, { pause: 0 });
  assert.deepEqual(r.team.map((m) => m.name), ["Светлана Камелина", "Евгений Зарвиров"]);
  assert.equal(r.items.length, 2);
  const a = r.items.find((x) => x.id === 11), b = r.items.find((x) => x.id === 12);
  assert.equal(a.amount, 150000);
  assert.equal(a.task.next, Date.parse("2026-11-10T19:00:00+03:00"));
  assert.equal(a.lastNote, Date.parse("2026-11-01T10:00:00+03:00"));
  assert.deepEqual(b.lastContact, { at: Date.parse("2026-11-02T10:00:00+03:00"), kind: "email" });
  assert.ok(b.rules.some((x) => x.code === "notask"));
  assert.ok(!b.rules.some((x) => x.code === "nocontact"));
});
