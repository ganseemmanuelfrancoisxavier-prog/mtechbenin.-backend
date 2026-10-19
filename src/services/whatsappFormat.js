// ─────────────────────────────────────────────────────────────────────────────
// Mise en forme des messages WhatsApp — fonctions pures.
//
// Aucune dépendance : ni Baileys, ni base, ni journal. Ce fichier ne contient
// que ce qui doit pouvoir être vérifié sans ouvrir de session sur le numéro de
// production.
// ─────────────────────────────────────────────────────────────────────────────

// ── Le gras de WhatsApp est plus fragile qu'il n'y paraît ───────────────────
//
// WhatsApp met en gras ce qui est entouré d'astérisques, mais chaque astérisque
// doit TOUCHER un caractère non blanc. `*Email : *` ne rend donc rien : la
// ligne s'affiche telle quelle, astérisques comprises, au milieu d'un message
// dont tout le reste est en gras.
//
// C'est exactement ce qui se produisait avec un profil sans nom : le gabarit
// écrivait `Profil :` suivi d'une valeur vide. On coupe donc les espaces avant
// de poser les astérisques.
function gras(texte) {
  const t = texte === null || texte === undefined ? "" : String(texte).trim();
  return t ? `*${t}*` : null;
}

// ── Un champ : libellé en gras, VALEUR en clair ─────────────────────────────
//
// La valeur reste en texte normal, et ce n'est pas une question de goût : un
// mot de passe ou un identifiant en gras se lit mal et se recopie mal. Le
// libellé porte la structure, la valeur doit rester lisible caractère par
// caractère — c'est précisément ce que le client va retaper ailleurs.
//
// ── Un champ vide ne s'affiche pas, il disparaît ────────────────────────────
//
// Un client a reçu ses identifiants sous cette forme :
//
//     Email :
//      Mot de passe :
//     Profil :
//     Code profil : 4444
//
// Trois libellés annonçant une valeur qui n'existe pas. Afficher un champ vide
// n'informe de rien et donne l'impression d'un message tronqué. Mieux vaut
// l'omettre : le client voit ce qu'il a, pas ce qui manque.
function champ(libelle, valeur) {
  const v = valeur === null || valeur === undefined ? "" : String(valeur).trim();
  if (!v) return null;
  // Les deux-points sont DANS le gras, l'espace qui suit en dehors : coller
  // l'astérisque fermante au « : » est ce qui permet à WhatsApp de reconnaître
  // le gras. `*Email : * valeur` ne rendrait rien.
  return `*${String(libelle).trim()} :* ${v}`;
}

// ── Assemblage ──────────────────────────────────────────────────────────────
//
// `.filter(Boolean)` — la convention précédente — supprimait AUSSI les chaînes
// vides, c'est-à-dire les lignes qui aèrent le message. Il fallait alors ruser
// avec des `\n` en tête de ligne, ce qui est incompatible avec le gras : un
// saut de ligne à l'intérieur des astérisques les neutralise.
//
// On n'écarte donc que ce qui est absent (`null`), jamais une ligne vide voulue.
function assembler(lignes) {
  return lignes.filter((l) => l !== null && l !== undefined).join("\n");
}

const SIGNATURE = "*L'équipe MTECHBENIN*";
const ENTETE = "*MTECHBENIN*";

module.exports = { gras, champ, assembler, SIGNATURE, ENTETE };
