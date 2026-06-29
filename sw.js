/* Observatório de Tecnologia Global — service worker
   Estratégia:
   - casca do app (shell): pré-cacheada para abrir offline (cai nos dados embutidos)
   - navegação: network-first com fallback para o index em cache
   - fontes (Google Fonts): stale-while-revalidate
   - /api/* (GET): network-first com fallback para o último cache
   - estáticos da mesma origem: stale-while-revalidate
   - POST e demais métodos passam direto (ex.: salvar catálogo, /api/ask)
   Para publicar uma atualização, troque a VERSION abaixo. */
const VERSION = "otg-v1";
const SHELL   = VERSION + "-shell";
const RUNTIME = VERSION + "-runtime";
const FONTS   = VERSION + "-fonts";

const CORE = [
  "./",
  "./index.html",
  "./fornecedores.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // best-effort: um arquivo ausente (ex.: fornecedores.js opcional) não derruba a instalação
    await Promise.allSettled(CORE.map((u) => c.add(new Request(u, { cache: "reload" }))));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// permite que a página peça atualização imediata
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

function isFont(url) {
  return url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // escrita (POST/PUT/DELETE) passa direto
  const url = new URL(req.url);

  // 1) Navegação -> network-first, fallback para a casca offline
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(SHELL);
        c.put("./index.html", fresh.clone());
        return fresh;
      } catch (_) {
        return (await caches.match("./index.html")) || (await caches.match("./")) || Response.error();
      }
    })());
    return;
  }

  // 2) Fontes -> stale-while-revalidate
  if (isFont(url)) {
    e.respondWith((async () => {
      const c = await caches.open(FONTS);
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r && r.status === 200) c.put(req, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
    return;
  }

  // 3) APIs da mesma origem (GET) -> network-first com fallback ao cache
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.status === 200) {
          const c = await caches.open(RUNTIME);
          c.put(req, fresh.clone());
        }
        return fresh;
      } catch (_) {
        const hit = await caches.match(req);
        return hit || new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
    })());
    return;
  }

  // 4) Estáticos da mesma origem -> stale-while-revalidate
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(SHELL);
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r && r.status === 200) c.put(req, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
    return;
  }

  // 5) Demais origens (ex.: AwesomeAPI de câmbio): deixa passar
});
