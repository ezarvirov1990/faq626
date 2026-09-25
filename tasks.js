// Правила вкладки «Задачи» — чистые функции без обращений к Bitrix.

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const MSK_OFFSET = 3 * HOUR; // Москва без перехода на летнее время
// Правка срока сразу после постановки задачи — не перенос
export const MOVE_GRACE_MS = 10 * 60e3;
export const OVERDUE_MS = 48 * HOUR;

export function mskDayStart(ms) {
  return Math.floor((ms + MSK_OFFSET) / DAY) * DAY - MSK_OFFSET;
}

// Переносы срока, перед которыми в тот же день по Москве не было нашего касания.
// moves: [{ at, ... }], touches: времена касаний (мс), taskCreated: когда поставлена задача (мс).
// К каждому нарушению добавляется lastTouch — последнее касание до переноса (или null).
export function untouchedMoves(moves, touches, taskCreated) {
  const out = [];
  for (const m of moves) {
    if (m.at - taskCreated < MOVE_GRACE_MS) continue;
    const before = touches.filter((x) => x <= m.at);
    const lastTouch = before.length ? Math.max(...before) : null;
    if (lastTouch !== null && lastTouch >= mskDayStart(m.at)) continue;
    out.push({ ...m, lastTouch });
  }
  return out;
}

// Состояние задач лида/сделки по его незакрытым задачам (дела CRM с полем DEADLINE):
// none — задач нет, overdue — есть просроченная больше 2 дней (deadline — самая старая), ok — остальное.
export function taskState(openTasks, now) {
  if (!openTasks.length) return { kind: "none" };
  const late = openTasks
    .map((a) => Date.parse(a.DEADLINE || ""))
    .filter((d) => d && now - d > OVERDUE_MS);
  return late.length ? { kind: "overdue", deadline: Math.min(...late) } : { kind: "ok" };
}
