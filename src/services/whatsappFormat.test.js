const test = require("node:test");
const assert = require("node:assert");
const { gras, champ, assembler, SIGNATURE, ENTETE } = require("./whatsappFormat");

// ── gras ────────────────────────────────────────────────────────────────────

test("le texte est entoure d asterisques", () => {
  assert.strictEqual(gras("Abonnement activé"), "*Abonnement activé*");
});

// LE point du fichier. WhatsApp exige que chaque asterisque TOUCHE un
// caractere non blanc : `* texte *` ne rend aucun gras, et la ligne s affiche
// avec ses asterisques visibles au milieu d un message qui, lui, est en gras.
test("les espaces de bord sont coupes — sinon WhatsApp n affiche pas le gras", () => {
  assert.strictEqual(gras("  Merci pour votre confiance.  "), "*Merci pour votre confiance.*");
  assert.strictEqual(gras("\tCode\n"), "*Code*");
});

test("un texte vide ne produit pas une paire d asterisques orpheline", () => {
  for (const v of ["", "   ", "\n", "\t ", null, undefined]) {
    assert.strictEqual(gras(v), null, "valeur : " + JSON.stringify(v));
  }
});

test("un nombre est accepte — un montant ou un code n est pas toujours une chaine", () => {
  assert.strictEqual(gras(481902), "*481902*");
  assert.strictEqual(gras(0), "*0*");
});

// ── champ ───────────────────────────────────────────────────────────────────

// Le libelle porte la structure, la VALEUR reste en clair : un mot de passe ou
// une adresse en gras se lit mal et se recopie mal — et c est precisement ce
// que le client va retaper ailleurs.
test("le libelle est en gras, la valeur en clair", () => {
  assert.strictEqual(champ("Email", "a@b.com"), "*Email :* a@b.com");
  assert.strictEqual(champ("Code profil", "4444"), "*Code profil :* 4444");
  assert.strictEqual(champ("Mot de passe", "Xk92#pQ7"), "*Mot de passe :* Xk92#pQ7");
});

// Le defaut signale par le commercant : un client avait recu
//   Email :
//    Mot de passe :
//   Profil :
// trois libelles annoncant une valeur qui n existe pas.
test("un champ vide DISPARAIT au lieu de s afficher sans valeur", () => {
  for (const v of ["", "   ", null, undefined]) {
    assert.strictEqual(champ("Email", v), null, "valeur : " + JSON.stringify(v));
  }
});

test("une valeur entouree d espaces est nettoyee, pas rejetee", () => {
  assert.strictEqual(champ("Profil", "  Profil 3  "), "*Profil :* Profil 3");
});

// Les deux-points sont DANS le gras : sans cela l asterisque fermante suivrait
// une espace, et WhatsApp n afficherait aucun gras sur la ligne.
test("les deux-points restent a l interieur du gras", () => {
  assert.ok(champ("Email", "a@b.com").startsWith("*Email :*"));
});

// ── assembler ───────────────────────────────────────────────────────────────

test("les lignes absentes sont ecartees, les lignes VIDES conservees", () => {
  // La distinction est le coeur de l assemblage : `.filter(Boolean)` supprimait
  // aussi les lignes vides, donc l aeration du message.
  const m = assembler([ENTETE, "", champ("Email", "a@b.com"), champ("Profil", ""), "", SIGNATURE]);
  assert.strictEqual(m, "*MTECHBENIN*\n\n*Email :* a@b.com\n\n*L'équipe MTECHBENIN*");
});

test("aucune ligne du message assemble ne porte d asterisque orpheline", () => {
  const m = assembler([
    ENTETE, "",
    gras("Abonnement Netflix activé"), "",
    champ("Email", "a@b.com"),
    champ("Mot de passe", ""), // absent : ne doit rien laisser
    champ("Profil", null), // absent aussi
    "",
    "*Suivi :* https://mtechbenin.com/suivi/MTECH-2026-X",
    "", SIGNATURE,
  ]);

  for (const ligne of m.split("\n")) {
    if (ligne === "") continue;

    // Nombre PAIR d asterisques : une asterisque orpheline s afficherait telle
    // quelle au client.
    const n = (ligne.match(/\*/g) || []).length;
    assert.strictEqual(n % 2, 0, "asterisques impaires : " + ligne);

    // La vraie regle de WhatsApp porte sur la PAIRE, pas sur la ligne :
    // l asterisque ouvrante doit etre suivie d un caractere non blanc, la
    // fermante precedee d un caractere non blanc. Ce qui vient APRES la
    // fermante — une espace, puis la valeur en clair — n a aucune importance.
    for (const segment of ligne.match(/\*[^*]*\*/g) || []) {
      const interieur = segment.slice(1, -1);
      assert.ok(interieur.length > 0, "gras vide : " + ligne);
      assert.strictEqual(
        interieur,
        interieur.trim(),
        "espace collee a une asterisque : " + ligne,
      );
    }
  }
});

test("l entete et la signature sont deja en gras", () => {
  assert.strictEqual(ENTETE, "*MTECHBENIN*");
  assert.strictEqual(SIGNATURE, "*L'équipe MTECHBENIN*");
});
