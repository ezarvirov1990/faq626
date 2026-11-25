// «Неделя» → activity and payments by hour of one MSK day (user, 25.11.2026): outgoing calls and sent messages of
// B2C managers (from the «Лента событий» events) next to «В2С Продажа» deals moved to «Оплачено» (all of them,
// site orders on user 181 included — user's choice), so the two can be compared hour by hour.
const H = 3600e3;
export const PAY_STAGE = "C27:WON";
export const PAY_PIPELINE = 27;
// Partner / certificate promo codes are left out of the payments (user, 25.11.2026: BKL50050, LYH250100, PRTN-BNJ6T…):
// three capitals + amount + discount (100/250/500 + 50/100) or «PRTN-…». Deal fields «Промокод» and «promocode».
export const PROMO_FIELDS = ["UF_CRM_1599368075", "UF_CRM_68D3C6840C8BB"];
export const excludedPromo = (code) => /^[A-Z]{3}\d{3}(?:50|100)$/.test(String(code || "").trim()) || /^PRTN-/i.test(String(code || "").trim());

const mskHour = (at) => new Date(at + 3 * H).getUTCHours();

// events: feed events of the day; ids: managers counted → { [managerId]: { calls: [24], msgs: [24] } }
// A Wazzup echo whose text went out under 2+ managers or 3+ times that day is a template (robot / mass send) — skipped.
export function autoTemplates(events) {
  const by = new Map();
  for (const e of events) if (e.kind === "msg" && e.tpl) { const s = by.get(e.tpl) || by.set(e.tpl, { n: 0, who: new Set() }).get(e.tpl); s.n++; s.who.add(e.managerId); }
  return new Set([...by].filter(([, s]) => s.who.size >= 2 || s.n >= 3).map(([k]) => k));
}

export function activityByHour(events, ids) {
  const want = new Set(ids.map(Number)), out = {}, auto = autoTemplates(events);
  for (const e of events) {
    if (!want.has(Number(e.managerId)) || (e.tpl && auto.has(e.tpl))) continue;
    const k = e.kind === "msg" ? "msgs" : e.kind === "call" && e.outgoing ? "calls" : null;
    if (!k) continue;
    const m = out[e.managerId] || (out[e.managerId] = { calls: Array(24).fill(0), msgs: Array(24).fill(0) });
    m[k][mskHour(e.at)]++;
  }
  return out;
}

// moves: stage history rows (OWNER_ID, CREATED_TIME); deals: id → { owner, sum } → [{ h, owner, sum, deal }]
// A deal moved to «Оплачено» twice in one day counts once (the first move).
export function paymentsByHour(moves, deals) {
  const seen = new Set(), out = [];
  for (const m of [...moves].sort((a, b) => Date.parse(a.CREATED_TIME) - Date.parse(b.CREATED_TIME))) {
    const id = Number(m.OWNER_ID);
    if (seen.has(id)) continue;
    seen.add(id);
    const d = deals[id] || {};
    if (d.promo) continue;
    out.push({ h: mskHour(Date.parse(m.CREATED_TIME)), deal: id, owner: d.owner || null, sum: d.sum || 0 });
  }
  return out;
}

// Bitrix: every «В2С Продажа» move to «Оплачено» during the day, then owners and amounts of those deals
export async function collectPayments(bx, day) {
  const iso = (t) => new Date(t + 3 * H).toISOString().slice(0, 19) + "+03:00";
  const moves = [];
  let start = 0;
  do {
    const r = await bx.call("crm.stagehistory.list", { entityTypeId: 2, filter: { CATEGORY_ID: PAY_PIPELINE, STAGE_ID: PAY_STAGE, ">=CREATED_TIME": iso(day), "<CREATED_TIME": iso(day + 24 * H) },
      select: ["OWNER_ID", "CREATED_TIME"], order: { ID: "ASC" }, start });
    moves.push(...((r.result || {}).items || []));
    start = r.next;
  } while (start);
  const ids = [...new Set(moves.map((m) => Number(m.OWNER_ID)))], deals = {};
  for (let i = 0; i < ids.length; i += 50) {
    const rows = await bx.list("crm.deal.list", { filter: { ID: ids.slice(i, i + 50) }, select: ["ID", "ASSIGNED_BY_ID", "OPPORTUNITY", ...PROMO_FIELDS] });
    for (const d of rows) deals[d.ID] = { owner: Number(d.ASSIGNED_BY_ID), sum: Math.round(Number(d.OPPORTUNITY) || 0), promo: PROMO_FIELDS.some((k) => excludedPromo(d[k])) };
  }
  return { payments: paymentsByHour(moves, deals), promoSkipped: Object.values(deals).filter((d) => d.promo).length };
}
