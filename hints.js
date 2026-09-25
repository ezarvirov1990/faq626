// Подсказки по лидам: «запрос / итог / следующий шаг». Их готовят вручную (в сессии с Claude Code)
// и загружают на сервер; здесь — проверка и слияние, без обращений к диску и Bitrix.

export const HINT_MAX = 400;
const FIELDS = ["request", "outcome", "next"];

// Слить загруженные подсказки с имеющимися. incoming: { "<ID лида>": {request, outcome, next, at?} | null }.
// null удаляет подсказку. Любая ошибка отклоняет всю загрузку — чтобы не сохранить половину.
export function mergeHints(existing, incoming, now = Date.now()) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) throw new Error("Подсказки должны быть объектом { ID лида: подсказка }");
  const out = { ...existing };
  for (const [id, hint] of Object.entries(incoming)) {
    if (!/^\d+$/.test(id)) throw new Error(`Неверный номер лида: ${id}`);
    if (hint === null) { delete out[id]; continue; }
    const clean = {};
    for (const f of FIELDS) {
      const v = hint && hint[f];
      if (typeof v !== "string" || !v.trim()) throw new Error(`Лид ${id}: нет поля ${f}`);
      if (v.length > HINT_MAX) throw new Error(`Лид ${id}: поле ${f} длиннее ${HINT_MAX} символов`);
      clean[f] = v.trim();
    }
    const at = hint.at ? Date.parse(hint.at) : now;
    if (Number.isNaN(at)) throw new Error(`Лид ${id}: неверная дата подсказки`);
    clean.at = new Date(at).toISOString();
    out[id] = clean;
  }
  return out;
}

// Подсказка устарела, если после неё в лиде было новое сообщение или звонок.
export function hintStale(hint, lastActivity) {
  return Boolean(lastActivity) && Date.parse(lastActivity) > Date.parse(hint.at);
}
