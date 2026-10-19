// Tests du journal des mails traites par le bot OTP, qui sert aussi de garde
// d'unicite. Prisma est bouchonne dans le cache des modules, comme dans
// otpRouting.resolve.test.js.
const test = require("node:test");
const assert = require("node:assert");

const prismaPath = require.resolve("../src/services/prisma");
let COMPORTEMENT = "ok";
const ECRITS = [];
const MAJ = [];

require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: {
    otpCourriel: {
      create: async ({ data }) => {
        if (COMPORTEMENT === "doublon") {
          const e = new Error("Unique constraint failed on the fields: (`messageId`)");
          e.code = "P2002";
          throw e;
        }
        if (COMPORTEMENT === "table-absente") {
          const e = new Error('The table `public.OtpCourriel` does not exist');
          e.code = "P2021";
          throw e;
        }
        ECRITS.push(data);
        return { id: "ligne-1", ...data };
      },
      update: async ({ where, data }) => {
        MAJ.push({ where, data });
        return { id: where.id, ...data };
      },
    },
  },
};

const { cleCourriel, revendiquerCourriel, consignerCourriel } = require("./otpJournal");

test("cle : le Message-ID fait foi quand il existe", () => {
  assert.strictEqual(cleCourriel({ messageId: "<abc@netflix.com>", sujet: "x" }), "<abc@netflix.com>");
});

// Sans Message-ID, la cle doit etre STABLE (meme mail relu -> meme cle) et ne
// pas dependre de la boite : un mail renvoye dans une seconde boite est le meme
// mail, et ne doit pas partir deux fois.
test("cle : sans Message-ID, une empreinte stable qui ignore la boite", () => {
  const champs = { expediteur: "info@account.netflix.com", date: new Date("2026-10-12T17:23:00Z"), sujet: "Code", code: "4821" };
  const k1 = cleCourriel({ ...champs, boite: "a@gmail.com" });
  const k2 = cleCourriel({ ...champs, boite: "b@gmail.com" });
  assert.strictEqual(k1, k2);
  assert.match(k1, /^sans-id:[0-9a-f]{32}$/);
  assert.notStrictEqual(k1, cleCourriel({ ...champs, code: "9999" }));
});

test("revendication : un mail neuf est revendique et journalise", async () => {
  COMPORTEMENT = "ok";
  const r = await revendiquerCourriel({ messageId: "<m1>", boite: "a@gmail.com", type: "connexion" });
  assert.strictEqual(r.id, "ligne-1");
  assert.strictEqual(ECRITS.at(-1).messageId, "<m1>");
});

// Le coeur de la garde : le meme mail, revendique une seconde fois (seconde
// boite, seconde passe), est refuse par la BASE — pas par un test prealable que
// deux processus pourraient passer en meme temps.
test("revendication : un mail deja revendique rend null", async () => {
  COMPORTEMENT = "doublon";
  assert.strictEqual(await revendiquerCourriel({ messageId: "<m1>", boite: "b@gmail.com", type: "connexion" }), null);
});

// Table absente (migration non appliquee) : on ne perd pas le code pour autant.
// L'appelant continue sans garde d'unicite, la garde par commande restant en place.
test("revendication : table indisponible -> on continue, signale", async () => {
  COMPORTEMENT = "table-absente";
  const r = await revendiquerCourriel({ messageId: "<m2>", boite: "a@gmail.com", type: "connexion" });
  assert.deepStrictEqual(r, { indisponible: true });
});

test("consignation : met a jour la ligne revendiquee", async () => {
  await consignerCourriel({ id: "ligne-1" }, { decision: "envoye", destinataire: "Aubina" });
  assert.deepStrictEqual(MAJ.at(-1), { where: { id: "ligne-1" }, data: { decision: "envoye", destinataire: "Aubina" } });
});

test("consignation : sans ligne (journal indisponible), ne fait rien", async () => {
  const avant = MAJ.length;
  await consignerCourriel({ indisponible: true }, { decision: "envoye" });
  await consignerCourriel(null, { decision: "envoye" });
  assert.strictEqual(MAJ.length, avant);
});
