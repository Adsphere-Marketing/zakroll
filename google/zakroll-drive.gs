/*
 * Zak Roll — script Google Drive (Apps Script).
 * Crée les dossiers des scripts chez chaque courtier, à la demande du serveur Zak Roll.
 *
 * Mise en place (une fois, 5 minutes) :
 *   1. https://script.google.com → Nouveau projet → coller tout ce fichier → remplacer SECRET par le secret du serveur.
 *   2. Déployer → Nouveau déploiement → type « Application Web » → Exécuter en tant que : Moi → Accès : Tout le monde → Déployer.
 *   3. Autoriser (écran « Google n'a pas validé cette application » → Paramètres avancés → Ouvrir … (non sécurisé)).
 *   4. Copier l'URL qui finit par /exec → DRIVE_SCRIPT_URL dans /opt/zakroll/.env, et le même secret dans DRIVE_SECRET.
 *   Pour modifier le script ensuite : Déployer → Gérer les déploiements → Modifier → Version : Nouvelle version (l'URL reste la même).
 *
 * Actions (POST JSON) :
 *   { secret, action: "ping" }                             → { ok, email }
 *   { secret, action: "ensure", jobs: [{ key, parent, name }] }  → { ok, results: [{ key, folder, raw, rawUrl }] }
 *        parent = dossier du courtier ; crée Video Content (ou utilise « Content ») / name / raw
 *   { secret, action: "rename", jobs: [{ key, raw, name }] }     → { ok, results: [{ key, folder }] }
 *        renomme le dossier parent de raw
 */
var SECRET = "METS_LE_SECRET_ICI";

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: "JSON invalide" }); }
  if (!body || typeof body.secret !== "string" || body.secret !== SECRET) return out({ ok: false, error: "refusé" });
  var lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (err) { return out({ ok: false, error: "occupé, réessaie" }); }
  try {
    if (body.action === "ping") return out({ ok: true, email: Session.getEffectiveUser().getEmail() });
    if (body.action === "ensure") return out({ ok: true, results: (body.jobs || []).map(ensure) });
    if (body.action === "rename") return out({ ok: true, results: (body.jobs || []).map(rename) });
    return out({ ok: false, error: "action inconnue" });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() { return out({ ok: true, service: "zakroll-drive" }); }

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Premier sous-dossier dont le nom est dans la liste ; sinon le crée avec le premier nom.
function child(parent, names, create) {
  for (var i = 0; i < names.length; i++) {
    var it = parent.getFoldersByName(names[i]);
    if (it.hasNext()) return it.next();
  }
  return create ? parent.createFolder(names[0]) : null;
}

function ensure(j) {
  try {
    if (!j || !j.parent || !j.name) return { key: j && j.key, error: "parent ou nom manquant" };
    var top = DriveApp.getFolderById(j.parent);
    var vc = child(top, ["Video Content", "Content"], true);
    var f = child(vc, [j.name], true);
    var raw = child(f, ["raw"], true);
    return { key: j.key, folder: f.getId(), raw: raw.getId(), rawUrl: "https://drive.google.com/drive/folders/" + raw.getId() };
  } catch (err) {
    return { key: j && j.key, error: String(err && err.message || err) };
  }
}

function rename(j) {
  try {
    if (!j || !j.raw || !j.name) return { key: j && j.key, error: "raw ou nom manquant" };
    var raw = DriveApp.getFolderById(j.raw);
    var parents = raw.getParents();
    if (!parents.hasNext()) return { key: j.key, error: "dossier raw sans parent" };
    var f = parents.next();
    if (f.getName() !== j.name) f.setName(j.name);
    return { key: j.key, folder: f.getId() };
  } catch (err) {
    return { key: j && j.key, error: String(err && err.message || err) };
  }
}
