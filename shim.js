/* Pont entre l'app (écrite pour les capacités claude.ai : db, user, downloads) et l'API du serveur Zak Roll.
   Injecté par server.js avant le code de l'app. window.__ZR_ROLE = "admin" | "team". */
(function () {
  "use strict";
  var ROLE = window.__ZR_ROLE === "admin" ? "admin" : "team";
  var cache = { content: {}, progress: {}, trash: {} };   // id -> { data, version }
  var docListeners = {};   // "collection/id" -> Set(fn)
  var colListeners = {};   // "collection"    -> Set(fn)
  var ready = null;
  var es = null;

  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function fromResponse(r, body) {
    if (r.status === 401 || r.status === 403 || r.status === 404 || r.status === 400) return err((body && body.code) || "invalid_argument", body && body.message);
    return err("unavailable", body && body.message);
  }
  async function api(method, path, body) {
    var r;
    try {
      r = await fetch(path, {
        method: method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: "same-origin",
        cache: "no-store"
      });
    } catch (e) { throw err("unavailable", "Réseau"); }
    var data = null;
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw fromResponse(r, data);
    return data;
  }

  function docSnap(collection, id) {
    var d = cache[collection][id];
    return {
      id: id,
      exists: !!d,
      data: function () { return d ? JSON.parse(JSON.stringify(d.data)) : undefined; },
      metadata: { fromCache: false, hasPendingWrites: false }
    };
  }
  function querySnap(collection) {
    var ids = Object.keys(cache[collection]).sort();
    var docs = ids.map(function (id) { return docSnap(collection, id); });
    return {
      docs: docs, size: docs.length, empty: docs.length === 0,
      docChanges: function () { return docs.map(function (d, i) { return { type: "added", doc: d, oldIndex: -1, newIndex: i }; }); },
      metadata: { fromCache: false, hasPendingWrites: false }
    };
  }
  function notifyDoc(collection, id) {
    var s = docListeners[collection + "/" + id];
    if (s) s.forEach(function (fn) { try { fn(docSnap(collection, id)); } catch (e) { console.error(e); } });
    var c = colListeners[collection];
    if (c) c.forEach(function (fn) { try { fn(querySnap(collection)); } catch (e) { console.error(e); } });
  }
  function applyState(state) {
    ["content", "progress", "trash"].forEach(function (c) {
      var col = state[c];
      if (!col || typeof col !== "object") { if (c === "trash" && ROLE !== "admin") cache[c] = {}; return; }
      cache[c] = {};
      Object.keys(col).forEach(function (id) { cache[c][id] = { data: col[id].data, version: col[id].version }; });
    });
  }
  function notifyAll() {
    ["content", "progress", "trash"].forEach(function (c) {
      Object.keys(docListeners).forEach(function (k) { if (k.indexOf(c + "/") === 0) notifyDoc(c, k.slice(c.length + 1)); });
      var s = colListeners[c];
      if (s) s.forEach(function (fn) { try { fn(querySnap(c)); } catch (e) { console.error(e); } });
    });
  }
  function load() {
    if (!ready) ready = api("GET", "/api/state").then(function (st) { applyState(st); connect(); return true; });
    return ready;
  }
  var backoff = 1000;
  function connect() {
    if (es) { try { es.close(); } catch (_) {} }
    es = new EventSource("/api/events");
    es.addEventListener("doc", function (ev) {
      try {
        var m = JSON.parse(ev.data);
        if (!cache[m.collection]) return;
        if (m.data == null) delete cache[m.collection][m.id];
        else cache[m.collection][m.id] = { data: m.data, version: m.version };
        notifyDoc(m.collection, m.id);
      } catch (e) { console.error(e); }
    });
    es.onopen = function () {
      if (backoff > 1000) { api("GET", "/api/state").then(function (st) { applyState(st); notifyAll(); }).catch(function () {}); }
      backoff = 1000;
    };
    es.onerror = function () {
      try { es.close(); } catch (_) {}
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
  }
  function split(p) {
    var parts = String(p).split("/").filter(Boolean);
    if (parts.length !== 2) throw new TypeError("Chemin de document invalide : " + p);
    return parts;
  }
  function docRef(collection, id) {
    var key = collection + "/" + id;
    return {
      id: id, path: key,
      get: function () { return load().then(function () { return docSnap(collection, id); }); },
      set: function (data) {
        return api("PUT", "/api/doc/" + collection + "/" + encodeURIComponent(id), { mode: "set", data: data })
          .then(function (r) { cache[collection][id] = { data: JSON.parse(JSON.stringify(data)), version: r.version }; notifyDoc(collection, id); });
      },
      update: function (data) {
        return api("PUT", "/api/doc/" + collection + "/" + encodeURIComponent(id), { mode: "update", data: data })
          .then(function () { return api("GET", "/api/doc/" + collection + "/" + encodeURIComponent(id)); })
          .then(function (d) { if (d && d.exists) { cache[collection][id] = { data: d.data, version: d.version }; notifyDoc(collection, id); } });
      },
      delete: function () {
        return api("DELETE", "/api/doc/" + collection + "/" + encodeURIComponent(id))
          .then(function () { delete cache[collection][id]; notifyDoc(collection, id); });
      },
      onSnapshot: function (next, error) {
        var set = docListeners[key] || (docListeners[key] = new Set());
        set.add(next);
        load().then(function () { if (set.has(next)) next(docSnap(collection, id)); })
          .catch(function (e) { if (error) error(e); });
        return function () { set.delete(next); };
      },
      collection: function (sub) { return colRef(collection + "/" + id + "/" + sub); },
      acquire: function () { return Promise.resolve({ acquired: true }); }
    };
  }
  function colRef(collection) {
    var self = {
      path: collection,
      doc: function (id) { return docRef(collection, id || ("d-" + Math.random().toString(36).slice(2, 10))); },
      add: function (data) { var r = self.doc(); return r.set(data).then(function () { return r; }); },
      where: function () { return self; }, orderBy: function () { return self; }, limit: function () { return self; },
      get: function () { return load().then(function () { return querySnap(collection); }); },
      onSnapshot: function (next, error) {
        var set = colListeners[collection] || (colListeners[collection] = new Set());
        set.add(next);
        load().then(function () { if (set.has(next)) next(querySnap(collection)); })
          .catch(function (e) { if (error) error(e); });
        return function () { set.delete(next); };
      }
    };
    return self;
  }
  var db = {
    doc: function (p) { var s = split(p); if (!cache[s[0]]) throw new TypeError("Collection inconnue : " + s[0]); return docRef(s[0], s[1]); },
    collection: function (p) { if (!cache[p]) throw new TypeError("Collection inconnue : " + p); return colRef(p); }
  };
  var user = {
    isOwner: function () { return Promise.resolve(ROLE === "admin"); },
    canEdit: function () { return Promise.resolve(ROLE === "admin"); },
    can: function () { return Promise.resolve(true); },
    id: function () { return Promise.resolve("zr-" + ROLE); },
    me: function () { return Promise.resolve({ id: "zr-" + ROLE, name: ROLE === "admin" ? "Édouard" : "" }); },
    profiles: function () { return Promise.resolve({}); }
  };
  var downloads = {
    save: function (opts) {
      var data = opts && opts.data, name = (opts && opts.filename) || "fichier";
      var blob = data instanceof Blob ? data : new Blob([data], { type: "application/octet-stream" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);
      return Promise.resolve();
    }
  };
  var caps = { db: db, user: user, downloads: downloads };
  window.claude = { use: function (name) { return Promise.resolve(caps[name] || null); } };
})();
