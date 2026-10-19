// Test d'integration du traitement d'un mail (`processEmail`), refonte du
// 13/10/2026.
//
// Les mails sont les VRAIS mails Netflix anonymises (__fixtures__). La base,
// WhatsApp, l'e-mail et le rapprochement des paniers sont bouchonnes dans le
// cache des modules : on observe ce qui PART, et a QUI.
const test = require("node:test");
const assert = require("node:assert");
const COURRIELS = require("./__fixtures__/courriels-netflix.json");

process.env.VENDOR_WHATSAPP_NUMBER = "+22900000001";
process.env.NODE_ENV = "production";
process.env.RESEND_FROM_EMAIL = "MTECHBENIN <noreply@mtechbenin.com>";

// ── Etat simule ─────────────────────────────────────────────────────────────
const NETFLIX = { id: "s-netflix", name: "Netflix", slug: "netflix", category: "family", transfertOtp: true };
let BASE, ENVOIS;

function reinitialiser() {
  BASE = {
    services: [NETFLIX],
    comptes: [
      { id: "c-a", email: "compte-a@gmail.com", serviceId: "s-netflix" },
      { id: "c-b", email: "compte-b@gmail.com", serviceId: "s-netflix" },
    ],
    occupations: [
      occupation("o-aubina", "c-a", "Aubina", "+22900000011", "2026-10-07"),
      occupation("o-tounde", "c-b", "Tounde", "+22900000022", "2026-09-16"),
    ],
    journal: [],
    otpLogs: [],
  };
  ENVOIS = { clients: [], admin: [] };
}

function occupation(id, accountId, nom, numero, debut) {
  return {
    id, accountId,
    occupantName: nom, occupantWhatsapp: numero,
    startedAt: new Date(debut), endsAt: null, releasedAt: null,
    profile: { id: `p-${id}`, profile: nom.toUpperCase(), capacite: 1, email: "" },
    order: {
      id: `cmd-${id}`, clientName: nom, clientWhatsapp: numero, clientEmail: null,
      isGift: false, giftWhatsapp: null, createdAt: new Date(debut),
      service: { name: "Netflix", slug: "netflix", category: "family" },
    },
  };
}

const bouchon = (chemin, exports) => {
  const p = require.resolve(chemin);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

bouchon("../src/utils/logger", { info() {}, warn() {}, error() {}, debug() {} });
bouchon("./orderReconciler", { reconcileSubscriptionOrders: async () => {}, reconcileIfStale: async () => {} });
bouchon("../src/services/whatsapp", {
  sendMessage: async (numero, message) => { ENVOIS.admin.push(message); return true; },
  sendOTPToClient: async ({ clientWhatsapp, clientName, otpCode }) => {
    ENVOIS.clients.push({ a: clientName, numero: clientWhatsapp, code: otpCode });
    return true;
  },
  sendOTPNotifToAdmin: async () => true,
});
bouchon("../src/services/email", {
  getFrom: () => "MTECHBENIN <noreply@mtechbenin.com>",
  sendAdminAlert: async () => true,
  sendOTPToClient: async () => true,
  sendOTPNotifToAdmin: async () => true,
});
bouchon("../src/services/prisma", {
  subscriptionService: { findMany: async () => BASE.services },
  streamingAccount: {
    findMany: async ({ where }) => BASE.comptes.filter((c) => where.serviceId.in.includes(c.serviceId)),
  },
  profileOccupancy: {
    findMany: async ({ where } = {}) =>
      BASE.occupations.filter((o) => !where?.profile?.accountId || o.accountId === where.profile.accountId),
  },
  subscriptionOrder: { findMany: async () => [] },
  otpRequest: { findMany: async () => [], updateMany: async () => ({}) },
  oTPLog: {
    findFirst: async ({ where }) =>
      BASE.otpLogs.find((l) => l.orderId === where.orderId && l.otpCode === where.otpCode) || null,
    create: async ({ data }) => { BASE.otpLogs.push(data); return { id: `log-${BASE.otpLogs.length}`, ...data }; },
  },
  otpCourriel: {
    create: async ({ data }) => {
      if (BASE.journal.some((l) => l.messageId === data.messageId)) {
        const e = new Error("Unique constraint failed"); e.code = "P2002"; throw e;
      }
      const ligne = { id: `j-${BASE.journal.length + 1}`, ...data };
      BASE.journal.push(ligne);
      return ligne;
    },
    update: async ({ where, data }) => {
      const l = BASE.journal.find((x) => x.id === where.id);
      Object.assign(l, data);
      return l;
    },
  },
});

const { processEmail } = require("./imapBot");

// Un mail tel que le rend mailparser, a partir d'un echantillon reel.
function mail(nom, { ecritA, messageId }) {
  const c = COURRIELS[nom];
  return {
    from: { value: [{ address: c.expediteur, name: c.nomAffiche }], text: `${c.nomAffiche} <${c.expediteur}>` },
    subject: c.sujet,
    text: c.texte,
    to: { value: [{ address: ecritA }], text: ecritA },
    // Comme Gmail : l'en-tete de verification, EN TETE du mail (headerLines
    // garde l'ordre reel). Signe pour netflix.com sur les vrais mails
    // Netflix, pour mtechbenin.com sur nos propres alertes.
    headerLines: [
      {
        key: "authentication-results",
        line:
          "Authentication-Results: " +
          (/mtechbenin/.test(c.expediteur)
            ? "mx.google.com; dkim=pass header.i=@mtechbenin.com"
            : "mx.google.com; dkim=pass header.i=@account.netflix.com; dmarc=pass header.from=netflix.com"),
      },
      { key: "from", line: `From: ${c.nomAffiche} <${c.expediteur}>` },
    ],
    headers: new Map(),
    messageId: messageId || `<${nom}@netflix.com>`,
    date: new Date("2026-10-12T17:23:00Z"),
  };
}

test.beforeEach(reinitialiser);

test("traitement : notre propre alerte ne declenche rien", async () => {
  await processEmail(mail("interne-alerte", { ecritA: "compte-a@gmail.com" }), "compte-a@gmail.com");
  assert.deepStrictEqual(ENVOIS.clients, []);
  assert.deepStrictEqual(ENVOIS.admin, []);
  assert.strictEqual(BASE.journal.length, 0, "un mail interne n'est meme pas journalise");
});

test("traitement : code d'identification ecrit au compte B -> Tounde, seul occupant de B", async () => {
  await processEmail(mail("connexion-compte-b", { ecritA: "compte-b@gmail.com" }), "compte-b@gmail.com");
  assert.deepStrictEqual(ENVOIS.clients, [{ a: "Tounde", numero: "+22900000022", code: "4821" }]);
  assert.strictEqual(BASE.journal[0].decision, "envoye");
  assert.strictEqual(BASE.journal[0].destinataire, "Tounde");
});

// Le cas qui a fait reecrire le routage : la boite connectee n'est qu'un
// transport. Netflix a ecrit au compte A : le code est pour le client de A.
test("traitement : ecrit au compte A mais lu dans la boite B -> client de A", async () => {
  await processEmail(mail("connexion-compte-b", { ecritA: "compte-a@gmail.com" }), "compte-b@gmail.com");
  assert.deepStrictEqual(ENVOIS.clients.map((e) => e.a), ["Aubina"]);
});

// Le meme mail, lu deux fois (seconde boite, seconde passe) : un seul envoi.
test("traitement : un mail lu deux fois ne part qu'une fois", async () => {
  const m = mail("connexion-compte-b", { ecritA: "compte-b@gmail.com" });
  await processEmail(m, "compte-b@gmail.com");
  await processEmail(m, "compte-a@gmail.com");
  assert.strictEqual(ENVOIS.clients.length, 1);
});

// La boucle du 12/10 : le code part, l'alerte revient dans la boite A (qui est
// ADMIN_EMAIL), et ne doit rien declencher.
test("traitement : apres un envoi, l'alerte relue ne renvoie pas le code", async () => {
  await processEmail(mail("connexion-compte-b", { ecritA: "compte-b@gmail.com" }), "compte-b@gmail.com");
  await processEmail(mail("interne-alerte", { ecritA: "compte-a@gmail.com" }), "compte-a@gmail.com");
  assert.deepStrictEqual(ENVOIS.clients.map((e) => e.a), ["Tounde"]);
});

test("traitement : code de gestion -> administrateur seul, aucun client", async () => {
  await processEmail(mail("gestion-confirmation", { ecritA: "compte-b@gmail.com" }), "compte-b@gmail.com");
  assert.deepStrictEqual(ENVOIS.clients, []);
  assert.strictEqual(ENVOIS.admin.length, 1);
  assert.match(ENVOIS.admin[0], /582913/);
  assert.match(ENVOIS.admin[0], /gestion/i);
  assert.strictEqual(BASE.journal[0].decision, "admin");
});

test("traitement : demande par lien -> administrateur, avec le lien, aucun client", async () => {
  await processEmail(mail("connexion-compte-a", { ecritA: "compte-a@gmail.com" }), "compte-a@gmail.com");
  assert.deepStrictEqual(ENVOIS.clients, []);
  assert.strictEqual(ENVOIS.admin.length, 1);
  assert.match(ENVOIS.admin[0], /Approuver : https:\/\/www\.netflix\.com\//);
});

test("traitement : nouvel appareil -> rien ne part, journalise comme ignore", async () => {
  await processEmail(mail("information-nouvel-appareil", { ecritA: "compte-b@gmail.com" }), "compte-b@gmail.com");
  assert.deepStrictEqual(ENVOIS.clients, []);
  assert.deepStrictEqual(ENVOIS.admin, []);
  assert.strictEqual(BASE.journal[0].decision, "ignore");
});

test("traitement : promotion et paiement mis a jour -> rien ne part", async () => {
  await processEmail(mail("promotion", { ecritA: "compte-a@gmail.com" }), "compte-a@gmail.com");
  await processEmail(mail("information-paiement", { ecritA: "compte-a@gmail.com" }), "compte-a@gmail.com");
  assert.deepStrictEqual(ENVOIS.clients, []);
  assert.deepStrictEqual(ENVOIS.admin, []);
});

// ── Divergences d'analyse et replis ouverts (revue de securite) ─────────────

// Deux en-tetes From : Gmail peut verifier la signature sur l'un pendant que
// l'analyseur en lit un autre. On ne transmet rien.
test("traitement : deux en-tetes From -> aucun envoi a un client", async () => {
  const m = mail("connexion-compte-b", { ecritA: "compte-b@gmail.com" });
  m.headerLines.push({ key: "from", line: "From: Netflix <info@account.netflix.com>" });
  await processEmail(m, "compte-b@gmail.com");
  assert.deepStrictEqual(ENVOIS.clients, []);
});

test("traitement : deux adresses dans From -> aucun envoi a un client", async () => {
  const m = mail("connexion-compte-b", { ecritA: "compte-b@gmail.com" });
  m.from.value.push({ address: "x@escroc.com", name: "" });
  await processEmail(m, "compte-b@gmail.com");
  assert.deepStrictEqual(ENVOIS.clients, []);
});

// Sans en-tete ordonne (headerLines), on ne retombe pas sur une lecture qui
// pourrait prendre un en-tete glisse par le faussaire : non verifie.
test("traitement : sans headerLines, un en-tete de signature ne suffit pas", async () => {
  const m = mail("connexion-compte-b", { ecritA: "compte-b@gmail.com" });
  m.headers = new Map([["authentication-results", "mx.google.com; dmarc=pass header.from=netflix.com"]]);
  delete m.headerLines;
  await processEmail(m, "compte-b@gmail.com");
  assert.deepStrictEqual(ENVOIS.clients, []);
});
