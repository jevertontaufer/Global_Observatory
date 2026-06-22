/* ============================================================
   Observatório de Tecnologia Global — Backend (Node + Express)
   Pronto para deploy no Render como Web Service.

   O que ele faz:
   - Serve o site estático (index.html, fornecedores.js, sw.js, manifest.json...)
   - GET  /api/suppliers          catálogo compartilhado (persistido em arquivo)
   - POST /api/suppliers          publica um fornecedor para todos
   - GET  /api/news?area=&lang=    notícias por área (RSS do Google News -> JSON, com cache)
   - GET  /api/fx                  cotação (cache do AwesomeAPI; opcional)
   - POST /api/ask                 resumo por IA usando sua ANTHROPIC_API_KEY
   - GET  /api/health              status

   Variáveis de ambiente (defina no painel do Render):
   - ANTHROPIC_API_KEY   (obrigatória só para /api/ask)
   - ANTHROPIC_MODEL     (opcional; padrão claude-haiku-4-5-20251001)
   - DATA_DIR            (opcional; padrão ./data — use um Render Disk para persistir)
   - PORT                (o Render injeta automaticamente)
   ============================================================ */

"use strict";
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "256kb" }));

/* CORS liberado (frontend pode estar no mesmo domínio ou em outro) */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------- persistência simples em arquivo ----------
   ATENÇÃO: no plano free do Render o disco é efêmero (zera a cada deploy/restart).
   Para um catálogo durável, monte um Render Disk e aponte DATA_DIR para ele,
   ou troque estas funções por um banco (Postgres/Supabase). A interface abaixo
   isola a persistência para facilitar essa troca. */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const SUP_FILE = path.join(DATA_DIR, "suppliers.json");
function ensureStore() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  if (!fs.existsSync(SUP_FILE)) {
    try { fs.writeFileSync(SUP_FILE, "[]"); } catch (e) {}
  }
}
function readSuppliers() {
  try { return JSON.parse(fs.readFileSync(SUP_FILE, "utf8")) || []; }
  catch (e) { return []; }
}
function writeSuppliers(arr) {
  try { fs.writeFileSync(SUP_FILE, JSON.stringify(arr, null, 2)); return true; }
  catch (e) { return false; }
}
ensureStore();

/* util */
function clean(s, max) { return String(s == null ? "" : s).trim().slice(0, max || 200); }
function normUrl(u) { u = clean(u, 300); if (!u) return ""; u = /^https?:\/\//i.test(u) ? u : "https://" + u; return u.replace(/\/+$/, ""); }

/* ============================================================
   FORNECEDORES (compartilhados)
   ============================================================ */
app.get("/api/suppliers", (req, res) => {
  res.json({ items: readSuppliers() });
});

app.post("/api/suppliers", (req, res) => {
  const b = req.body || {};
  const nm = clean(b.nm, 120);
  const url = normUrl(b.site || b.url);
  if (!nm || !url) return res.status(400).json({ error: "Informe ao menos nome e site." });
  const item = {
    id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    nm,
    pais: clean(b.pais, 60),
    cats: Array.isArray(b.cats) ? b.cats.slice(0, 6).map(c => clean(c, 40)) : [],
    tag: clean(b.tag, 240),
    url,
    contato: clean(b.contato, 120),
    ts: Date.now()
  };
  const arr = readSuppliers();
  // dedupe simples por url
  if (arr.some(s => (s.url || "").toLowerCase() === item.url.toLowerCase())) {
    return res.status(409).json({ error: "Esse site já está no catálogo." });
  }
  arr.push(item);
  if (!writeSuppliers(arr)) return res.status(500).json({ error: "Falha ao salvar." });
  res.json({ item });
});

/* ============================================================
   NOTÍCIAS — RSS do Google News -> JSON (com cache em memória)
   ============================================================ */
const newsCache = new Map(); // key -> {ts, items}
const NEWS_TTL = 15 * 60 * 1000; // 15 min

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .trim();
}
function parseRss(xml) {
  const items = [];
  const blocks = xml.split(/<item>/).slice(1);
  for (const blk of blocks) {
    const body = blk.split(/<\/item>/)[0];
    const pick = (tag) => {
      const m = body.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">"));
      return m ? decodeEntities(m[1]) : "";
    };
    const title = pick("title");
    const link = pick("link");
    if (!title || !link) continue;
    let pub = pick("pubDate");
    if (pub) { const d = new Date(pub); if (!isNaN(d)) pub = d.toLocaleDateString("pt-BR"); }
    items.push({ title, link, source: pick("source"), pubDate: pub });
    if (items.length >= 6) break;
  }
  return items;
}

app.get("/api/news", async (req, res) => {
  const area = clean(req.query.area, 120);
  const lang = (clean(req.query.lang, 2) || "pt").toLowerCase();
  if (!area) return res.status(400).json({ error: "Parâmetro 'area' é obrigatório." });
  const map = { pt: ["pt-BR", "BR", "BR:pt-419"], en: ["en-US", "US", "US:en"], es: ["es-419", "BR", "BR:es-419"] };
  const [hl, gl, ceid] = map[lang] || map.pt;
  const key = lang + "|" + area;
  const hit = newsCache.get(key);
  if (hit && Date.now() - hit.ts < NEWS_TTL) return res.json({ items: hit.items, cached: true });
  try {
    const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(area) +
      "&hl=" + hl + "&gl=" + gl + "&ceid=" + encodeURIComponent(ceid);
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; ObservatorioTech/1.0)" } });
    clearTimeout(to);
    if (!r.ok) throw new Error("rss " + r.status);
    const xml = await r.text();
    const items = parseRss(xml);
    newsCache.set(key, { ts: Date.now(), items });
    res.json({ items });
  } catch (e) {
    res.status(502).json({ error: "Não foi possível obter notícias agora.", items: [] });
  }
});

/* ============================================================
   COTAÇÃO — cache do AwesomeAPI (opcional; reduz chamadas)
   ============================================================ */
let fxCache = { ts: 0, data: null };
const FX_TTL = 20 * 1000;
app.get("/api/fx", async (req, res) => {
  const pairs = clean(req.query.pairs, 120) || "USD-BRL,EUR-BRL,CNY-BRL,EUR-USD";
  if (fxCache.data && Date.now() - fxCache.ts < FX_TTL) return res.json(fxCache.data);
  try {
    const r = await fetch("https://economia.awesomeapi.com.br/json/last/" + encodeURIComponent(pairs), { cache: "no-store" });
    if (!r.ok) throw new Error("fx " + r.status);
    const data = await r.json();
    fxCache = { ts: Date.now(), data };
    res.json(data);
  } catch (e) {
    if (fxCache.data) return res.json(fxCache.data); // serve o último válido
    res.status(502).json({ error: "Cotação indisponível." });
  }
});

/* ============================================================
   IA — resumo da busca (provedor configurável)
   Prioridade: Gemini (TEM NÍVEL GRATUITO) > Anthropic (pago).
   Defina UMA destas chaves no Render:
     - GEMINI_API_KEY     gratuito via Google AI Studio (aistudio.google.com)
     - ANTHROPIC_API_KEY  pago, por uso
   Modelos (opcionais):
     - GEMINI_MODEL       padrão gemini-2.5-flash
     - ANTHROPIC_MODEL    padrão claude-haiku-4-5-20251001
   ============================================================ */
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
function aiProvider() {
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}
function buildPrompts(q, ctx) {
  const langName = { pt: "português", en: "English", es: "español" }[ctx.lang] || "português";
  const system =
    "Você é o assistente do Observatório de Tecnologia Global. " +
    "Responda em " + langName + ", em no máximo 3 frases, de forma objetiva e útil. " +
    "Use SOMENTE os dados de contexto fornecidos (feiras e áreas). " +
    "Não invente datas, números ou eventos que não estejam no contexto. " +
    "Se o contexto estiver vazio, diga que não há resultados para esses termos e sugira refinar a busca.";
  const user = "Pergunta do usuário:\n" + q + "\n\nContexto (JSON):\n" + JSON.stringify(ctx).slice(0, 6000);
  return { system, user };
}
async function askGemini(q, ctx) {
  const { system, user } = buildPrompts(q, ctx);
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(GEMINI_MODEL) + ":generateContent?key=" + encodeURIComponent(process.env.GEMINI_API_KEY);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);
  const r = await fetch(url, {
    method: "POST", signal: ctrl.signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: 400, temperature: 0.4 }
    })
  });
  clearTimeout(to);
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("gemini " + r.status + " " + t.slice(0, 200)); }
  const data = await r.json();
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || "").join("").trim();
}
async function askAnthropic(q, ctx) {
  const { system, user } = buildPrompts(q, ctx);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", signal: ctrl.signal,
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 400, system, messages: [{ role: "user", content: user }] })
  });
  clearTimeout(to);
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("anthropic " + r.status + " " + t.slice(0, 200)); }
  const data = await r.json();
  return (data.content || []).map(b => (b.type === "text" ? b.text : "")).join("\n").trim();
}
app.post("/api/ask", async (req, res) => {
  const provider = aiProvider();
  if (!provider) return res.status(503).json({ error: "IA não configurada. Defina GEMINI_API_KEY (gratuito) ou ANTHROPIC_API_KEY no Render." });
  const b = req.body || {};
  const q = clean(b.q, 500);
  if (!q) return res.status(400).json({ error: "Pergunta vazia." });
  const ctx = b.context || {};
  try {
    const answer = provider === "gemini" ? await askGemini(q, ctx) : await askAnthropic(q, ctx);
    res.json({ answer, provider });
  } catch (e) {
    res.status(502).json({ error: "IA indisponível no momento." });
  }
});

/* ============================================================
   PUSH — notificações Web Push (VAPID)
   Variáveis de ambiente no Render:
     - VAPID_PUBLIC   chave pública (gerada para você)
     - VAPID_PRIVATE  chave privada (NUNCA no GitHub — só aqui)
     - PUSH_CONTACT   ex.: mailto:seu-email@exemplo.com
     - PUSH_TOKEN     senha secreta para disparar avisos (invente uma)
   Disparo:
     - GET /api/push/run?token=SEU_TOKEN          → avisa feiras que começam em 7 ou 1 dia
     - GET /api/push/run?token=SEU_TOKEN&test=1   → envia uma notificação de teste agora
   Um "despertador" externo (cron-job.org) deve chamar /api/push/run 1x/dia,
   porque no plano free o Render dorme e não dispara sozinho.
   ============================================================ */
let webpush = null;
try { webpush = require("web-push"); } catch (e) {}
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || "";
const PUSH_TOKEN = process.env.PUSH_TOKEN || "";
const PUSH_CONTACT = process.env.PUSH_CONTACT || "mailto:contato@exemplo.com";
const pushReady = !!(webpush && VAPID_PUBLIC && VAPID_PRIVATE);
if (pushReady) { try { webpush.setVapidDetails(PUSH_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE); } catch (e) { console.log("VAPID inválido:", e.message); } }

const SUB_FILE = path.join(DATA_DIR, "subs.json");
function readSubs() { try { return JSON.parse(fs.readFileSync(SUB_FILE, "utf8")) || []; } catch (e) { return []; } }
function writeSubs(a) { try { fs.writeFileSync(SUB_FILE, JSON.stringify(a)); return true; } catch (e) { return false; } }

/* Datas das feiras para os avisos. MANTENHA EM DIA junto com o index.html. */
const PUSH_FAIRS = [
  { nm: "CES", s: "2026-01-06", url: "https://www.ces.tech" },
  { nm: "MWC Barcelona", s: "2026-03-02", url: "https://www.mwcbarcelona.com" },
  { nm: "South Summit Brazil", s: "2026-03-25", url: "https://www.southsummit.io/brazil" },
  { nm: "Hannover Messe", s: "2026-04-20", url: "https://www.hannovermesse.de/en" },
  { nm: "Gramado Summit", s: "2026-05-06", url: "https://gramadosummit.com" },
  { nm: "COMPUTEX", s: "2026-06-02", url: "https://www.computextaipei.com.tw/en" },
  { nm: "Web Summit Rio", s: "2026-06-08", url: "https://rio.websummit.com" },
  { nm: "Febraban Tech", s: "2026-08-24", url: "https://febrabantech.febraban.org.br" },
  { nm: "IFA Berlin", s: "2026-09-04", url: "https://www.ifa-berlin.com" },
  { nm: "Futurecom", s: "2026-10-06", url: "https://www.futurecom.com.br" },
  { nm: "SPS Nuremberg", s: "2026-11-24", url: "https://sps.mesago.com/nuernberg/en.html" },
  { nm: "GITEX Global", s: "2026-12-07", url: "https://www.gitex.com" }
];

app.get("/api/push/vapid", (req, res) => res.json({ key: pushReady ? VAPID_PUBLIC : "" }));

app.post("/api/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: "Inscrição inválida." });
  const subs = readSubs();
  if (!subs.some(s => s.endpoint === sub.endpoint)) { subs.push(sub); writeSubs(subs); }
  res.json({ ok: true });
});

async function sendToAll(payload) {
  if (!pushReady) return { sent: 0, removed: 0 };
  const subs = readSubs();
  const keep = [];
  let sent = 0;
  for (const s of subs) {
    try { await webpush.sendNotification(s, JSON.stringify(payload)); sent++; keep.push(s); }
    catch (e) { if (!(e && (e.statusCode === 404 || e.statusCode === 410))) keep.push(s); } // remove só inscrições expiradas
  }
  writeSubs(keep);
  return { sent, removed: subs.length - keep.length };
}

app.get("/api/push/run", async (req, res) => {
  if (!pushReady) return res.status(503).json({ error: "Push não configurado (faltam VAPID_PUBLIC/VAPID_PRIVATE)." });
  if (PUSH_TOKEN && req.query.token !== PUSH_TOKEN) return res.status(401).json({ error: "Token inválido." });
  if (req.query.test) { const r = await sendToAll({ title: "Observatório de Tecnologia", body: "Teste de notificação ✓", url: "/" }); return res.json({ test: true, ...r }); }
  const milestones = [7, 1];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const fired = []; let sent = 0, removed = 0;
  for (const f of PUSH_FAIRS) {
    const start = new Date(f.s + "T00:00:00");
    const days = Math.round((start - today) / 86400000);
    if (milestones.includes(days)) {
      const r = await sendToAll({ title: "📅 " + f.nm, body: days === 1 ? "Começa amanhã!" : ("Começa em " + days + " dias"), url: f.url || "/" });
      sent += r.sent; removed += r.removed; fired.push({ nm: f.nm, days });
    }
  }
  res.json({ ok: true, fired, sent, removed });
});

/* ============================================================
   ESTÁTICOS + boot
   ============================================================ */
app.get("/api/health", (req, res) => res.json({ ok: true, ai: !!aiProvider(), provider: aiProvider(), push: pushReady, subs: readSubs().length, suppliers: readSuppliers().length }));

app.use(express.static(__dirname, { extensions: ["html"] }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Observatório no ar em :" + PORT + " | IA:" + (aiProvider() || "off") + " | push:" + pushReady));
