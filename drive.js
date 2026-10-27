"use strict";
/*
 * Zak Roll — dossiers Google Drive créés automatiquement.
 *
 * Quand un script a un code (ex. « Reno1 ») stable depuis 20 s, le serveur demande au script Google
 * (Apps Script déployé par Édouard, voir README) de créer, chez chaque courtier qui a le script :
 *   {Dossier du courtier} / Video Content / {Courtier}-{code} / raw
 * puis écrit le lien du dossier raw dans le script (le bouton « Déposer mes vidéos » s'en sert).
 * Si le code change ensuite, le dossier est renommé. Rien d'autre n'est touché dans Drive.
 *
 * Variables : DRIVE_SCRIPT_URL (adresse /exec du script Google), DRIVE_SECRET (le même secret que dans le script).
 */
const STABLE_MS = Number(process.env.DRIVE_STABLE_MS || 20000);
const DEBOUNCE_MS = 2000;
const PERIOD_MS = 60000;
const TIMEOUT_MS = 90000;

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const has = (x, b) => (Array.isArray(x.to) ? x.to.indexOf(b) >= 0 : !(Array.isArray(x.not) && x.not.indexOf(b) >= 0));
function folderIdOf(url) {
  const m = /folders\/([A-Za-z0-9_-]{10,})/.exec(String(url || ""));
  return m ? m[1] : "";
}
const folderUrl = (id) => "https://drive.google.com/drive/folders/" + id;

module.exports = function driveSync(opts) {
  const url = String(process.env.DRIVE_SCRIPT_URL || "").trim();
  const secret = String(process.env.DRIVE_SECRET || "").trim();
  const enabled = /^https?:\/\/\S+$/.test(url) && secret.length >= 16;
  const log = opts.log || console.log;
  const state = { enabled, inflight: false, lastRun: 0, lastOk: 0, lastError: "", created: 0, renamed: 0 };
  const seen = {};     // scriptId -> { code, since }   code vu, et depuis quand
  const applied = {};  // scriptId -> code pour lequel les dossiers existent (créés ou déjà là)
  let timer = null, timer2 = null;

  function init() {
    const c = opts.getContent();
    if (!isObj(c)) return;
    (c.scripts || []).forEach((s) => {
      const code = String(s.code || "").trim();
      if (!code) return;
      const missing = audience(c, s).some((b) => !folderIdOf((s.raw || {})[b.id]));
      if (!missing) applied[s.id] = code;
    });
    observe(0);
  }
  // Note le code de chaque script et depuis quand il n'a pas changé (appelé à chaque écriture).
  function observe(at) {
    const c = opts.getContent();
    if (!isObj(c)) return;
    const now = at == null ? Date.now() : at, live = {};
    (c.scripts || []).forEach((s) => {
      if (!isObj(s) || !s.id) return;
      const code = String(s.code || "").trim();
      if (!code) return;
      live[s.id] = 1;
      const sv = seen[s.id];
      if (!sv || sv.code !== code) seen[s.id] = { code, since: now };
    });
    Object.keys(seen).forEach((k) => { if (!live[k]) delete seen[k]; });
  }
  function audience(c, s) {
    return (c.brokers || []).filter((b) => isObj(b) && b.id && has(s, b.id) && folderIdOf(b.drive));
  }
  function schedule() {
    if (!enabled) return;
    observe();
    clearTimeout(timer); timer = setTimeout(tick, DEBOUNCE_MS);
    clearTimeout(timer2); timer2 = setTimeout(tick, STABLE_MS + 1500);
  }
  function plan() {
    const c = opts.getContent();
    if (!isObj(c)) return null;
    const now = Date.now(), ensure = [], rename = [];
    (c.scripts || []).forEach((s) => {
      if (!isObj(s) || !s.id) return;
      const code = String(s.code || "").trim();
      const sv = seen[s.id];
      if (!code || !sv || sv.code !== code || now - sv.since < STABLE_MS) return;
      audience(c, s).forEach((b) => {
        const name = String(b.name || b.id).trim() + "-" + code;
        const rawId = folderIdOf((s.raw || {})[b.id]);
        if (!rawId) ensure.push({ key: s.id + "|" + b.id, parent: folderIdOf(b.drive), name });
        else if (applied[s.id] && applied[s.id] !== code) rename.push({ key: s.id + "|" + b.id, raw: rawId, name, code });
      });
    });
    return { ensure, rename };
  }
  async function call(action, jobs) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ secret, action, jobs }),
        redirect: "follow",
        signal: ac.signal
      });
      const text = await r.text();
      let out;
      try { out = JSON.parse(text); } catch (_) { throw new Error("réponse illisible du script Google (" + r.status + ") : " + text.slice(0, 120)); }
      if (!out || out.ok !== true) throw new Error("script Google : " + ((out && out.error) || "réponse inattendue"));
      return out;
    } finally { clearTimeout(t); }
  }
  async function tick() {
    if (!enabled || state.inflight) return;
    observe();
    const p = plan();
    if (!p || (!p.ensure.length && !p.rename.length)) return;
    state.inflight = true; state.lastRun = Date.now();
    try {
      if (p.ensure.length) {
        const results = (await call("ensure", p.ensure)).results || [];
        const byKey = {};
        results.forEach((r) => { if (r && r.key) byKey[r.key] = r; });
        const okKeys = [];
        opts.patchContent((c) => {
          if (!isObj(c)) return false;
          let changed = false;
          p.ensure.forEach((j) => {
            const r = byKey[j.key];
            if (!r || !r.raw) { if (r && r.error) log("Drive : " + j.name + " → " + r.error); return; }
            const [sid, bid] = j.key.split("|");
            const s = (c.scripts || []).find((x) => isObj(x) && x.id === sid);
            if (!s) return;
            if (!isObj(s.raw)) s.raw = {};
            if (!folderIdOf(s.raw[bid])) { s.raw[bid] = folderUrl(r.raw); changed = true; }
            okKeys.push(j.key);
          });
          return changed;
        });
        state.created += okKeys.length;
        okKeys.forEach((k) => log("Drive : dossier prêt pour " + k.replace("|", " / ")));
        // Un script dont tous les dossiers existent maintenant est « appliqué » pour ce code.
        const c2 = opts.getContent();
        if (isObj(c2)) (c2.scripts || []).forEach((s) => {
          const code = String(s.code || "").trim();
          if (code && !audience(c2, s).some((b) => !folderIdOf((s.raw || {})[b.id]))) applied[s.id] = code;
        });
      }
      if (p.rename.length) {
        const results = (await call("rename", p.rename)).results || [];
        const ok = results.filter((r) => r && r.key && !r.error).length;
        results.forEach((r) => { if (r && r.error) log("Drive : renommage " + r.key + " → " + r.error); });
        state.renamed += ok;
        if (ok === p.rename.length) p.rename.forEach((j) => { applied[j.key.split("|")[0]] = j.code; });
      }
      state.lastOk = Date.now(); state.lastError = "";
    } catch (e) {
      state.lastError = String(e && e.message || e);
      log("Drive : " + state.lastError);
    } finally {
      state.inflight = false;
    }
  }
  if (enabled) {
    init();
    setInterval(tick, PERIOD_MS).unref();
    schedule();
    log("Dossiers Drive automatiques : actifs");
  } else log("Dossiers Drive automatiques : inactifs (DRIVE_SCRIPT_URL / DRIVE_SECRET absents)");

  return {
    onContentWrite: schedule,
    status: () => Object.assign({}, state, { pending: enabled ? plan() : null }),
    syncNow: tick,
    ping: async () => call("ping", [])
  };
};
