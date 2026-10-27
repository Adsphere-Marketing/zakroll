"use strict";
/*
 * Zak Roll — serveur minimal (Node 20, aucune dépendance).
 * Sert la page de l'app et garde ses données dans un fichier JSON.
 *
 * Liens :
 *   /<TEAM_PATH>          page des courtiers (lire, cocher)
 *   /admin-<ADMIN_TOKEN>  page d'Édouard (tout éditer)
 *
 * API (cookie signé requis) :
 *   GET    /api/state                   contenu + progression (+ corbeille pour l'admin)
 *   GET    /api/events                  flux SSE des changements
 *   PUT    /api/doc/:collection/:id     { mode: "set" | "update", data }
 *   DELETE /api/doc/:collection/:id
 *   GET    /api/drive/status            (admin) état des dossiers Drive automatiques
 *   POST   /api/drive/sync              (admin) forcer une passe
 *   POST   /api/drive/ping              (admin) tester le script Google
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const APP_DIR = path.join(__dirname, "app");
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const TEAM_PATH = String(process.env.TEAM_PATH || "equipe").trim().replace(/^\/+|\/+$/g, "");
const DOMAIN = String(process.env.DOMAIN || "").trim();
const COOKIE = "zr";
const MAX_BODY = 1024 * 1024;

if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 12) {
  console.error("ADMIN_TOKEN manquant ou trop court (12 caractères minimum).");
  process.exit(1);
}
if (!TEAM_PATH || /[^a-zA-Z0-9_-]/.test(TEAM_PATH)) {
  console.error("TEAM_PATH invalide : lettres, chiffres, - et _ seulement.");
  process.exit(1);
}

/* ---------- base de données : un fichier JSON ---------- */
const DB_FILE = path.join(DATA_DIR, "db.json");
const SEED_FILE = path.join(DATA_DIR, "seed.json");
const COLLECTIONS = ["content", "progress", "trash"];
let db = { content: {}, progress: {}, trash: {} };

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      COLLECTIONS.forEach((c) => { db[c] = raw && raw[c] && typeof raw[c] === "object" ? raw[c] : {}; });
      return;
    } catch (e) {
      console.error("db.json illisible, sauvegarde de côté :", e.message);
      fs.renameSync(DB_FILE, DB_FILE + ".corrompu-" + Date.now());
    }
  }
  if (fs.existsSync(SEED_FILE)) {
    try {
      const seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
      COLLECTIONS.forEach((c) => {
        const col = seed && seed[c] && typeof seed[c] === "object" ? seed[c] : {};
        Object.keys(col).forEach((id) => { db[c][id] = { data: col[id], version: 1, updatedAt: Date.now() }; });
      });
      console.log("Base créée à partir de seed.json");
    } catch (e) { console.error("seed.json illisible :", e.message); }
  }
  saveNow();
}
let saveTimer = null;
function saveSoon() { if (!saveTimer) saveTimer = setTimeout(saveNow, 150); }
function saveNow() {
  saveTimer = null;
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------- fusion « update » (objets fusionnés, le reste remplacé, null = valeur) ---------- */
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
function merge(base, patch) {
  const out = isObj(base) ? Object.assign({}, base) : {};
  Object.keys(patch).forEach((k) => {
    const v = patch[k];
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  });
  return out;
}

/* ---------- écriture interne (même chemin que l'API : version, sauvegarde, diffusion) ---------- */
function putDoc(collection, id, next) {
  const cur = db[collection][id];
  const doc = { data: next, version: (cur ? cur.version : 0) + 1, updatedAt: Date.now() };
  db[collection][id] = doc;
  saveSoon();
  broadcast(collection, id, doc);
  return doc;
}
const contentData = () => (db.content.main ? db.content.main.data : null);
function patchContent(fn) {
  const cur = contentData();
  if (!cur) return false;
  const copy = JSON.parse(JSON.stringify(cur));
  if (!fn(copy)) return false;
  putDoc("content", "main", copy);
  return true;
}
let drive = null; // démarré après le chargement de la base (voir le bas du fichier)

/* ---------- cookies signés ---------- */
const KEY = crypto.createHmac("sha256", ADMIN_TOKEN).update("zakroll-cookie-key").digest();
function sign(role) { return role + "." + crypto.createHmac("sha256", KEY).update(role).digest("base64url"); }
function roleFromCookie(req) {
  const h = req.headers.cookie || "";
  const m = h.match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]+)"));
  if (!m) return null;
  const v = decodeURIComponent(m[1]);
  const role = v.split(".")[0];
  if ((role === "admin" || role === "team") && safeEq(v, sign(role))) return role;
  return null;
}
function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function setCookie(res, role, req) {
  const secure = isHttps(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", COOKIE + "=" + encodeURIComponent(sign(role)) + "; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax" + secure);
}
function isHttps(req) {
  const xf = String(req.headers["x-forwarded-proto"] || "");
  return xf.split(",")[0].trim() === "https";
}

/* ---------- page ---------- */
let pageCache = { mtime: 0, html: "" };
function readPage() {
  const file = path.join(APP_DIR, "index.html");
  const st = fs.statSync(file);
  if (st.mtimeMs !== pageCache.mtime) {
    pageCache = { mtime: st.mtimeMs, html: fs.readFileSync(file, "utf8") };
  }
  return pageCache.html;
}
const SHIM = fs.readFileSync(path.join(__dirname, "shim.js"), "utf8");
function renderPage(role) {
  let html = readPage();
  // Le <title> de l'app remonte dans le <head> ; le pont vers l'API s'insère au début du <body>.
  let title = "";
  html = html.replace(/<title>[\s\S]*?<\/title>\s*/i, (m) => { title = m.trim(); return ""; });
  const inject = "<script>window.__ZR_ROLE=" + JSON.stringify(role) + ";\n" + SHIM + "\n</script>\n";
  if (title) html = html.replace(/<\/head>/i, title + "</head>");
  html = html.replace(/<body>/i, "<body>\n" + inject);
  return html;
}

/* ---------- SSE ---------- */
const clients = new Set();
function broadcast(collection, id, doc) {
  const payload = JSON.stringify({ collection, id, data: doc ? doc.data : null, version: doc ? doc.version : 0 });
  for (const c of clients) {
    if (collection === "trash" && c.role !== "admin") continue;
    try { c.res.write("event: doc\ndata: " + payload + "\n\n"); } catch (_) { clients.delete(c); }
  }
}
setInterval(() => {
  for (const c of clients) { try { c.res.write(": ping\n\n"); } catch (_) { clients.delete(c); } }
}, 25000).unref();

/* ---------- règles d'accès ---------- */
function canRead(role, collection) {
  if (!role) return false;
  if (collection === "trash") return role === "admin";
  return COLLECTIONS.indexOf(collection) >= 0;
}
function canWrite(role, collection) {
  if (!role) return false;
  if (role === "admin") return COLLECTIONS.indexOf(collection) >= 0;
  return collection === "progress";
}
const validId = (s) => typeof s === "string" && /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(s);

/* ---------- utilitaires HTTP ---------- */
function send(res, status, body, type) {
  const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": type || "application/json; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  res.end(buf);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error("too_large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(new Error("bad_json")); } });
    req.on("error", reject);
  });
}

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    const role = roleFromCookie(req);

    if (req.method === "GET" && (p === "/" || p === "")) {
      res.writeHead(302, { Location: "/" + TEAM_PATH }); res.end(); return;
    }
    if (req.method === "GET" && p === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (req.method === "GET" && p === "/healthz") { send(res, 200, { ok: true }); return; }

    if (req.method === "GET" && p === "/" + TEAM_PATH) {
      setCookie(res, role === "admin" ? "admin" : "team", req);
      send(res, 200, renderPage(role === "admin" ? "admin" : "team"), "text/html; charset=utf-8");
      return;
    }
    if (req.method === "GET" && p.startsWith("/admin-")) {
      const tok = p.slice("/admin-".length);
      if (!safeEq(tok, ADMIN_TOKEN)) { send(res, 404, "Introuvable", "text/plain; charset=utf-8"); return; }
      setCookie(res, "admin", req);
      send(res, 200, renderPage("admin"), "text/html; charset=utf-8");
      return;
    }
    if (req.method === "GET" && p === "/admin") {
      if (role !== "admin") { send(res, 404, "Introuvable", "text/plain; charset=utf-8"); return; }
      send(res, 200, renderPage("admin"), "text/html; charset=utf-8");
      return;
    }

    if (p.startsWith("/api/")) {
      if (!role) { send(res, 401, { code: "not_granted", message: "Ouvre la page par ton lien." }); return; }
      if (req.method === "GET" && p === "/api/state") {
        const out = { role, content: db.content, progress: db.progress };
        if (role === "admin") out.trash = db.trash;
        send(res, 200, out); return;
      }
      if (req.method === "GET" && p === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.write("retry: 3000\n\n");
        const c = { res, role };
        clients.add(c);
        req.on("close", () => clients.delete(c));
        return;
      }
      if (p === "/api/drive/status" || p === "/api/drive/sync" || p === "/api/drive/ping") {
        if (role !== "admin") { send(res, 403, { code: "invalid_argument", message: "Admin seulement." }); return; }
        if (req.method === "GET" && p === "/api/drive/status") { send(res, 200, drive.status()); return; }
        if (req.method === "POST" && p === "/api/drive/sync") { await drive.syncNow(); send(res, 200, drive.status()); return; }
        if (req.method === "POST" && p === "/api/drive/ping") {
          try { send(res, 200, await drive.ping()); } catch (e) { send(res, 502, { ok: false, error: String(e && e.message || e) }); }
          return;
        }
      }
      const m = p.match(/^\/api\/doc\/([^/]+)\/([^/]+)$/);
      if (m) {
        const collection = m[1], id = decodeURIComponent(m[2]);
        if (!validId(id) || COLLECTIONS.indexOf(collection) < 0) { send(res, 400, { code: "invalid_argument", message: "Chemin invalide." }); return; }
        if (req.method === "GET") {
          if (!canRead(role, collection)) { send(res, 403, { code: "invalid_argument", message: "Lecture refusée." }); return; }
          const doc = db[collection][id];
          send(res, 200, doc ? { exists: true, data: doc.data, version: doc.version } : { exists: false }); return;
        }
        if (!canWrite(role, collection)) { send(res, 403, { code: "invalid_argument", message: "Écriture refusée." }); return; }
        if (req.method === "DELETE") {
          const had = !!db[collection][id];
          delete db[collection][id];
          if (had) { saveSoon(); broadcast(collection, id, null); }
          send(res, 200, { ok: true }); return;
        }
        if (req.method === "PUT") {
          let body;
          try { body = await readBody(req); } catch (e) { send(res, 400, { code: "invalid_argument", message: e.message }); return; }
          const data = body && body.data;
          if (!isObj(data)) { send(res, 400, { code: "invalid_argument", message: "Le document doit être un objet." }); return; }
          const cur = db[collection][id];
          let next;
          if (body.mode === "update") {
            if (!cur) { send(res, 404, { code: "invalid_argument", message: "Document absent : update impossible." }); return; }
            next = merge(cur.data, data);
          } else next = data;
          const doc = putDoc(collection, id, next);
          if (collection === "content" && id === "main") drive.onContentWrite();
          send(res, 200, { ok: true, version: doc.version }); return;
        }
      }
      send(res, 404, { code: "invalid_argument", message: "Route inconnue." }); return;
    }

    send(res, 404, "Introuvable", "text/plain; charset=utf-8");
  } catch (e) {
    console.error(e);
    try { send(res, 500, { code: "unavailable", message: "Erreur serveur." }); } catch (_) {}
  }
});

loadDb();
drive = require("./drive.js")({ getContent: contentData, patchContent, log: (m) => console.log(m) });
server.listen(PORT, "0.0.0.0", () => {
  console.log("Zak Roll en marche sur le port " + PORT + (DOMAIN ? " pour " + DOMAIN : ""));
  console.log("Courtiers : /" + TEAM_PATH + "   Admin : /admin-<token>");
});
process.on("SIGTERM", () => { try { saveNow(); } catch (_) {} process.exit(0); });
process.on("SIGINT", () => { try { saveNow(); } catch (_) {} process.exit(0); });
