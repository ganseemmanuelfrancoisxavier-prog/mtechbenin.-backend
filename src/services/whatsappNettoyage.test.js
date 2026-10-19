const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Reproduit la propriete que `destroyAndClean` doit respecter : vider le
// CONTENU du dossier de session sans supprimer le dossier lui-meme.
//
// Le defaut d'origine faisait `fs.rmSync(dossier, { recursive: true })`. Sur
// Render, ou le chemin etait un dossier ordinaire, cela marchait. Sur le VPS
// c'est un POINT DE MONTAGE Docker : la suppression echoue avec EBUSY, la
// session revoquee survit, Baileys la relit, recoit un 401, et recommence —
// 590 fois par heure, pendant des jours.
//
// Le montage ne peut pas etre simule ici. Ce qui est verifiable, et qui suffit
// a fermer la regression, c'est que le nettoyage LAISSE LE DOSSIER EN PLACE :
// un dossier conserve n'a pas pu etre supprime, donc l'operation reste valide
// sur un point de montage.
function viderDossier(dossier) {
  if (!fs.existsSync(dossier)) return 0;
  let n = 0;
  for (const nom of fs.readdirSync(dossier)) {
    try {
      fs.rmSync(path.join(dossier, nom), { recursive: true, force: true });
      n += 1;
    } catch {}
  }
  return n;
}

function dossierTemporaire() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "session-test-"));
  fs.writeFileSync(path.join(d, "creds.json"), "{}");
  fs.writeFileSync(path.join(d, "session-229.json"), "{}");
  fs.mkdirSync(path.join(d, "sous-dossier"));
  fs.writeFileSync(path.join(d, "sous-dossier", "x.json"), "{}");
  return d;
}

test("le contenu est efface et le DOSSIER survit", () => {
  const d = dossierTemporaire();
  try {
    const n = viderDossier(d);
    assert.strictEqual(n, 3);
    // Le point essentiel : le dossier existe toujours. C'est ce qui rend
    // l'operation valable sur un point de montage.
    assert.ok(fs.existsSync(d), "le dossier ne doit pas etre supprime");
    assert.deepStrictEqual(fs.readdirSync(d), []);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("creds.json part — c'est lui qui porte la session revoquee", () => {
  const d = dossierTemporaire();
  try {
    viderDossier(d);
    assert.ok(!fs.existsSync(path.join(d, "creds.json")));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("un dossier absent ou deja vide ne fait pas echouer le nettoyage", () => {
  assert.strictEqual(viderDossier(path.join(os.tmpdir(), "n-existe-pas-" + Date.now())), 0);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "session-vide-"));
  try {
    assert.strictEqual(viderDossier(d), 0);
    assert.ok(fs.existsSync(d));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
