// Recopie des données vers le modèle compte + occupation.
//
// Rejouable : chaque écriture est conditionnée à l'absence de son résultat.
// On peut donc le relancer après correction sans créer de doublon, ce qui est
// indispensable pour une reprise en production.
//
//   node scripts/migrate-comptes-occupations.js            (rapport seul)
//   node scripts/migrate-comptes-occupations.js --appliquer (écrit)

require("dotenv").config();
const prisma = require("../src/services/prisma");
const { decrypt } = require("../src/utils/crypto");

const APPLIQUER = process.argv.includes("--appliquer");

async function main() {
  const profils = await prisma.familyAccount.findMany({
    include: { plan: { select: { serviceId: true } } },
    orderBy: { createdAt: "asc" },
  });

  console.log(`${profils.length} profil(s) à traiter`);

  // ── 1. Regrouper par (service, adresse) ──────────────────────────────────
  const groupes = new Map();
  for (const p of profils) {
    const serviceId = p.plan?.serviceId;
    if (!serviceId) {
      console.log(`  ! profil ${p.id} sans service (plan introuvable) — ignoré`);
      continue;
    }
    const cle = `${serviceId}::${p.email.trim().toLowerCase()}`;
    if (!groupes.has(cle)) groupes.set(cle, { serviceId, email: p.email.trim(), profils: [] });
    groupes.get(cle).profils.push(p);
  }

  console.log(`${groupes.size} compte(s) distinct(s)`);

  // ── 2. Divergences de mot de passe ───────────────────────────────────────
  // Chaque profil stocke sa propre copie : rien ne garantit qu'elles soient
  // identiques. On retient la plus récente et on liste les écarts, au lieu de
  // trancher en silence.
  //
  // La comparaison se fait sur le CLAIR, pas sur `passwordEncrypted` : `encrypt()`
  // tire un IV aléatoire à chaque appel, donc deux profils chiffrés séparément
  // avec le même mot de passe produisent presque toujours des chiffrés
  // différents. Comparer les chiffrés ferait remonter une "divergence" sur
  // quasiment tous les comptes multi-profils — du bruit, pas un signal. Un
  // déchiffrement en échec (autre clé, valeur corrompue ou vide) est un
  // problème distinct d'une vraie divergence : il est rapporté à part.
  const divergences = [];
  const illisibles = [];
  for (const g of groupes.values()) {
    const clairs = new Set();
    let profilsIllisibles = 0;
    for (const p of g.profils) {
      try {
        clairs.add(decrypt(p.passwordEncrypted));
      } catch {
        profilsIllisibles += 1;
      }
    }
    if (profilsIllisibles > 0) {
      illisibles.push({ email: g.email, profils: profilsIllisibles });
    }
    if (clairs.size > 1) {
      divergences.push({ email: g.email, versions: clairs.size, profils: g.profils.length });
    }
    const plusRecent = [...g.profils].sort((a, b) => b.createdAt - a.createdAt)[0];
    g.passwordEncrypted = plusRecent.passwordEncrypted;
  }

  if (illisibles.length > 0) {
    console.log(`\n!! ${illisibles.length} compte(s) avec un mot de passe indéchiffrable :`);
    for (const i of illisibles) {
      console.log(`   ${i.email} — ${i.profils} profil(s) illisible(s) (exclu(s) de la comparaison)`);
    }
  }

  if (divergences.length > 0) {
    console.log(`\n!! ${divergences.length} compte(s) avec des mots de passe divergents :`);
    for (const d of divergences) {
      console.log(`   ${d.email} — ${d.versions} versions sur ${d.profils} profils (la plus récente est retenue)`);
    }
  }

  // ── 3. Créer les comptes et rattacher les profils ────────────────────────
  let comptesCrees = 0;
  let profilsRattaches = 0;

  for (const g of groupes.values()) {
    // maxFluxSimultanes = max(4, nombre de profils) : un compte portant déjà 5
    // profils vendus ne doit pas devenir invendable du fait du nouveau plafond.
    const maxFlux = Math.max(4, g.profils.length);

    let compte = await prisma.streamingAccount.findUnique({
      where: { serviceId_email: { serviceId: g.serviceId, email: g.email } },
    });

    if (!compte) {
      if (!APPLIQUER) {
        console.log(`  + compte ${g.email} (${g.profils.length} profils, maxFlux=${maxFlux})`);
      } else {
        compte = await prisma.streamingAccount.create({
          data: {
            serviceId: g.serviceId,
            email: g.email,
            passwordEncrypted: g.passwordEncrypted,
            maxFluxSimultanes: maxFlux,
          },
        });
        comptesCrees += 1;
      }
    }

    // En simulation, `compte` reste `null` tant qu'il n'est pas créé : la
    // condition `p.accountId === compte.id` ne peut donc jamais l'exclure, et
    // chaque profil du groupe s'affiche comme à rattacher — c'est le
    // comportement voulu, seul moyen de vérifier ce rapprochement avant
    // `--appliquer`.
    for (const p of g.profils) {
      if (compte && p.accountId === compte.id) continue;
      if (!APPLIQUER) {
        console.log(`    -> profil ${p.profile} (${p.id}) serait rattaché au compte ${g.email}`);
        continue;
      }
      await prisma.familyAccount.update({
        where: { id: p.id },
        data: { accountId: compte.id },
      });
      profilsRattaches += 1;
    }
  }

  // ── 4. Convertir les rattachements en occupations ────────────────────────
  const rattaches = profils.filter((p) => p.currentOrderId);
  let occupationsCreees = 0;

  for (const p of rattaches) {
    // `findFirst` et non `findUnique` : l'unicité de `orderId` est partielle
    // (limitée aux occupations actives), donc Prisma ne l'expose pas comme clé.
    const existe = await prisma.profileOccupancy.findFirst({
      where: { orderId: p.currentOrderId },
    });
    if (existe) continue;

    const commande = await prisma.subscriptionOrder.findUnique({
      where: { id: p.currentOrderId },
    });
    if (!commande) {
      console.log(`  ! profil ${p.profile} pointe une commande absente (${p.currentOrderId}) — ignoré`);
      continue;
    }

    // Pour un cadeau, l'occupant est le destinataire : c'est lui qui utilise le
    // profil et qui demandera les codes.
    const estCadeau = Boolean(commande.isGift && commande.giftWhatsapp);
    const donnees = {
      profileId: p.id,
      orderId: commande.id,
      occupantName: estCadeau ? commande.giftName || commande.clientName : commande.clientName,
      occupantWhatsapp: estCadeau ? commande.giftWhatsapp : commande.clientWhatsapp,
      startedAt: commande.createdAt,
      endsAt: commande.expiresAt,
    };

    if (!APPLIQUER) {
      console.log(`  + occupation ${donnees.occupantName} -> ${p.profile} (fin : ${donnees.endsAt || "non renseignee"})`);
      continue;
    }
    await prisma.profileOccupancy.create({ data: donnees });
    occupationsCreees += 1;
  }

  console.log(
    APPLIQUER
      ? `\nAppliqué : ${comptesCrees} compte(s), ${profilsRattaches} profil(s) rattaché(s), ${occupationsCreees} occupation(s).`
      : `\nSimulation seule. Relancer avec --appliquer pour écrire.`,
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  // La pile, pas seulement le message : ce script s'execute contre une base
  // de production, souvent sous pression, et « ERREUR: undefined » ne dit pas
  // quelle requete ni quelle ligne a echoue.
  console.error("ERREUR:", err);
  await prisma.$disconnect();
  process.exit(1);
});
