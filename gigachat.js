// GigaChat API (Sber): OAuth token by the project's Authorization Key, then chat completions.
// Sber's endpoints use the Russian Ministry of Digital Development root CA — Node must trust it
// (NODE_EXTRA_CA_CERTS with russian_trusted_root_ca + sub_ca, see deploy/setup-hints.sh).
// Env: GIGACHAT_AUTH_KEY (base64 "client_id:client_secret" from developers.sber.ru), GIGACHAT_SCOPE
// (GIGACHAT_API_PERS — individual, GIGACHAT_API_B2B — sole proprietor, GIGACHAT_API_CORP — company).
import { randomUUID } from "node:crypto";

const OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const API_URL = "https://gigachat.devices.sberbank.ru/api/v1";

export function createGigaChat({ authKey, scope = "GIGACHAT_API_PERS", fetchImpl = fetch } = {}) {
  if (!authKey) throw new Error("GIGACHAT_AUTH_KEY is not set");
  let token = null; // { value, expiresAt }

  async function accessToken() {
    // tokens live 30 minutes; renew a minute early
    if (token && token.expiresAt - 60e3 > Date.now()) return token.value;
    const r = await fetchImpl(OAUTH_URL, {
      method: "POST",
      headers: { Authorization: "Basic " + authKey, RqUID: randomUUID(), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: "scope=" + encodeURIComponent(scope),
      signal: AbortSignal.timeout(30e3),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`GigaChat auth ${r.status}: ${j.message || j.error || "no token"}`);
    token = { value: j.access_token, expiresAt: Number(j.expires_at) || Date.now() + 25 * 60e3 };
    return token.value;
  }

  async function api(path, body) {
    const r = await fetchImpl(API_URL + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: "Bearer " + (await accessToken()), "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5 * 60e3),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`GigaChat ${path} ${r.status}: ${j.message || JSON.stringify(j).slice(0, 200)}`);
    return j;
  }

  return {
    models: async () => (await api("/models")).data.map((m) => m.id),
    // One user message in, the answer text and token usage out
    async complete(prompt, { model = "GigaChat-2-Pro", temperature = 0.2 } = {}) {
      const j = await api("/chat/completions", { model, temperature, messages: [{ role: "user", content: prompt }] });
      return { text: j.choices[0].message.content, usage: j.usage || {} };
    },
  };
}
