// Локальная версия дашборда: один раз собрать снимок и вшить его в HTML-файл.
// Использование: BITRIX_WEBHOOK=... node build-static.js <путь к выходному .html>
import { readFile, writeFile, rename } from "node:fs/promises";
import { createBitrix, collectSnapshot, loadConfig } from "./collector.js";

const out = process.argv[2];
if (!out) throw new Error("Укажите путь к выходному файлу");
const config = loadConfig(process.env);
if (!config.webhook) throw new Error("Не задан BITRIX_WEBHOOK");

const started = Date.now();
const snap = await collectSnapshot(createBitrix(config.webhook), config);
// При ошибках Bitrix оставляем прежний файл: на странице будет видно, что данные устарели
if (snap.batchErrors > 0) throw new Error(`Bitrix вернул ошибки в ${snap.batchErrors} запросах`);

const page = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
const json = JSON.stringify(snap).replaceAll("<", "\\u003c");
const html = page.replace('<script type="application/json" id="snapshot"></script>', () => `<script type="application/json" id="snapshot">${json}</script>`);
if (html === page) throw new Error("В index.html не найдено место для снимка");

// Пишем во временный файл и подменяем, чтобы браузер не прочитал файл наполовину
await writeFile(out + ".tmp", html, "utf8");
await rename(out + ".tmp", out);
const summary = Object.entries(snap.views).map(([k, v]) => `${k} ${v.items.length}/${v.totalOpen}`).join(", ");
console.log(`ok: ${summary} in ${Math.round((Date.now() - started) / 1000)}s`);
