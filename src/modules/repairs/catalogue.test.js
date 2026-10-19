// Tests CRUD du catalogue de réparation, aux quatre niveaux :
// RepairFamily → RepairModel → RepairJob → RepairOption.
//
// Objectif : répondre à « est-ce que le CRUD marche bien à tous les
// niveaux ? ». Même motif que `resolution.test.js` et
// `workers/otpRouting.resolve.test.js` : un `prisma` bouchonné, injecté dans
// le cache de modules AVANT de charger le contrôleur. Un vrai accès base
// rendrait ces tests inexécutables en CI, et ce sont précisément ceux qui
// garantissent qu'un administrateur qui crée/modifie/supprime dans le
// catalogue écrit bien ce qu'il croit écrire.
//
// Convention reprise de `resolution.test.js` : `BASE` (l'état de la base) et
// `CAPTURES` (ce que le contrôleur a réellement envoyé à Prisma) sont
// réaffectés au tout début de chaque test — jamais lus depuis une valeur que
// le test aurait lui-même calculée après coup.
const test = require("node:test");
const assert = require("node:assert");

const prismaPath = require.resolve("../../services/prisma");

let BASE;
let CAPTURES;

function base() {
  return { familles: [], modeles: [], jobs: [], options: [] };
}

function captures() {
  return {
    familyCreates: [], familyUpdates: [], familyDeletes: [],
    modelCreates: [], modelUpdates: [], modelDeletes: [],
    jobCreates: [], jobUpdates: [], jobDeletes: [],
    optionCreates: [], optionUpdates: [], optionDeletes: [],
  };
}

let idSeq = 0;
function makeId(prefix) {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

// ── Fabriques ────────────────────────────────────────────────────────────────
function famille({ id, name = "iPhone", slug, space = "APPLE", active = true, sortOrder = 0 }) {
  return { id, name, slug: slug || name.toLowerCase().replace(/\s+/g, "-"), space, active, sortOrder };
}
function modele({ id, familyId, name = "iPhone 13", slug, active = true, sortOrder = 0 }) {
  return { id, familyId, name, slug: slug || name.toLowerCase().replace(/\s+/g, "-"), active, sortOrder };
}
function job({ id, modelId, name = "Écran cassé", delay = null, active = true, sortOrder = 0 }) {
  return { id, modelId, name, delay, active, sortOrder };
}
function optionRow({ id, jobId, label = "Standard", price = 20000, active = true, sortOrder = 0 }) {
  return { id, jobId, label, price, active, sortOrder };
}

function fakeRes() {
  return {
    code: 200,
    corps: null,
    status(c) { this.code = c; return this; },
    json(v) { this.corps = v; return this; },
  };
}

// ── Bouchon Prisma ───────────────────────────────────────────────────────────
//
// Chaque `create`/`update`/`delete` capture EXACTEMENT ce qu'il reçoit, avant
// toute manipulation — c'est sur `CAPTURES` que portent les assertions, pas
// sur ce que le bouchon choisit d'en faire. Les `findMany`/`findUnique`
// reproduisent à la main les filtres imbriqués (`where.slug.startsWith`,
// `where.family.space`, `include.jobs.where.active`…) réellement envoyés par
// `repairs.controller.js`, comme le fait déjà `resolution.test.js` pour
// `resoudreOptions`.
require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: {
    repairFamily: {
      create: async ({ data }) => {
        CAPTURES.familyCreates.push(data);
        const row = { id: makeId("fam"), active: true, ...data };
        BASE.familles.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        CAPTURES.familyUpdates.push(data);
        const row = BASE.familles.find((f) => f.id === where.id);
        if (!row) throw new Error("Record to update not found.");
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }) => {
        CAPTURES.familyDeletes.push(where.id);
        const idx = BASE.familles.findIndex((f) => f.id === where.id);
        if (idx === -1) throw new Error("Record to delete does not exist.");
        const [row] = BASE.familles.splice(idx, 1);
        return row;
      },
      findUnique: async ({ where }) => {
        if (where.id !== undefined) return BASE.familles.find((f) => f.id === where.id) || null;
        if (where.slug !== undefined) return BASE.familles.find((f) => f.slug === where.slug) || null;
        return null;
      },
      findMany: async ({ where }) => {
        let rows = BASE.familles;
        if (where?.space !== undefined) rows = rows.filter((f) => f.space === where.space);
        if (where?.active !== undefined) rows = rows.filter((f) => f.active === where.active);
        if (where?.slug?.startsWith !== undefined) {
          rows = rows.filter((f) => f.slug.startsWith(where.slug.startsWith));
        }
        // Forme imbriquée attendue par `getCatalogueAdmin` — présente même
        // quand l'appelant (ex. `slugLibre`) n'en a besoin que du `slug`.
        return rows.map((f) => ({
          ...f,
          models: BASE.modeles.filter((m) => m.familyId === f.id).map((m) => ({
            ...m,
            jobs: BASE.jobs.filter((j) => j.modelId === m.id).map((j) => ({
              ...j,
              options: BASE.options.filter((o) => o.jobId === j.id),
            })),
          })),
        }));
      },
    },

    repairModel: {
      create: async ({ data }) => {
        CAPTURES.modelCreates.push(data);
        const row = { id: makeId("mod"), active: true, ...data };
        BASE.modeles.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        CAPTURES.modelUpdates.push(data);
        const row = BASE.modeles.find((m) => m.id === where.id);
        if (!row) throw new Error("Record to update not found.");
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }) => {
        CAPTURES.modelDeletes.push(where.id);
        const idx = BASE.modeles.findIndex((m) => m.id === where.id);
        if (idx === -1) throw new Error("Record to delete does not exist.");
        const [row] = BASE.modeles.splice(idx, 1);
        return row;
      },
      findUnique: async ({ where, include }) => {
        let row;
        if (where.id !== undefined) row = BASE.modeles.find((m) => m.id === where.id);
        else if (where.slug !== undefined) row = BASE.modeles.find((m) => m.slug === where.slug);
        if (!row) return null;
        if (!include) return { ...row };
        // Forme imbriquée de `getModele` : famille sélectionnée, réparations
        // actives, chacune avec ses seules options actives.
        const fam = BASE.familles.find((f) => f.id === row.familyId);
        const jobsActifs = BASE.jobs
          .filter((j) => j.modelId === row.id && j.active === true)
          .map((j) => ({
            ...j,
            options: BASE.options
              .filter((o) => o.jobId === j.id && o.active === true)
              .map((o) => ({ id: o.id, label: o.label, price: o.price })),
          }));
        return {
          ...row,
          family: fam ? { name: fam.name, slug: fam.slug, space: fam.space, active: fam.active } : null,
          jobs: jobsActifs,
        };
      },
      findMany: async ({ where }) => {
        let rows = BASE.modeles;
        if (where?.familyId !== undefined) rows = rows.filter((m) => m.familyId === where.familyId);
        if (where?.active !== undefined) rows = rows.filter((m) => m.active === where.active);
        if (where?.id?.in !== undefined) rows = rows.filter((m) => where.id.in.includes(m.id));
        if (where?.slug?.startsWith !== undefined) {
          rows = rows.filter((m) => m.slug.startsWith(where.slug.startsWith));
        }
        if (where?.name?.contains !== undefined) {
          const q = String(where.name.contains).toLowerCase();
          rows = rows.filter((m) => m.name.toLowerCase().includes(q));
        }
        if (where?.family?.space !== undefined) {
          rows = rows.filter((m) => {
            const f = BASE.familles.find((ff) => ff.id === m.familyId);
            if (!f || f.space !== where.family.space) return false;
            if (where.family.active !== undefined && f.active !== where.family.active) return false;
            return true;
          });
        }
        return rows.map((m) => ({ ...m, family: BASE.familles.find((f) => f.id === m.familyId) }));
      },
    },

    repairJob: {
      create: async ({ data }) => {
        CAPTURES.jobCreates.push(data);
        const { options, ...champs } = data;
        const row = { id: makeId("job"), active: true, ...champs };
        BASE.jobs.push(row);
        let optionsCreees = [];
        if (options && Array.isArray(options.create)) {
          optionsCreees = options.create.map((o) => {
            const opt = { id: makeId("opt"), jobId: row.id, active: true, ...o };
            BASE.options.push(opt);
            return opt;
          });
        }
        return { ...row, options: optionsCreees };
      },
      update: async ({ where, data }) => {
        CAPTURES.jobUpdates.push(data);
        const row = BASE.jobs.find((j) => j.id === where.id);
        if (!row) throw new Error("Record to update not found.");
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }) => {
        CAPTURES.jobDeletes.push(where.id);
        const idx = BASE.jobs.findIndex((j) => j.id === where.id);
        if (idx === -1) throw new Error("Record to delete does not exist.");
        const [row] = BASE.jobs.splice(idx, 1);
        return row;
      },
      findUnique: async ({ where, include }) => {
        const row = BASE.jobs.find((j) => j.id === where.id);
        if (!row) return null;
        if (include?.options) {
          return { ...row, options: BASE.options.filter((o) => o.jobId === row.id) };
        }
        return { ...row };
      },
    },

    repairOption: {
      create: async ({ data }) => {
        CAPTURES.optionCreates.push(data);
        const row = { id: makeId("opt"), active: true, ...data };
        BASE.options.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        CAPTURES.optionUpdates.push(data);
        const row = BASE.options.find((o) => o.id === where.id);
        if (!row) throw new Error("Record to update not found.");
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }) => {
        CAPTURES.optionDeletes.push(where.id);
        const idx = BASE.options.findIndex((o) => o.id === where.id);
        if (idx === -1) throw new Error("Record to delete does not exist.");
        const [row] = BASE.options.splice(idx, 1);
        return row;
      },
    },
  },
};

const {
  getFamilles, getModelesDeFamille, getModele, rechercherModeles, getCatalogueAdmin,
  creerFamille, modifierFamille, supprimerFamille,
  creerModele, modifierModele, supprimerModele,
  creerReparation, modifierReparation, supprimerReparation,
  dupliquerReparation,
  creerOption, modifierOption, supprimerOption,
} = require("./repairs.controller");

// ═══════════════════════════════════════════════════════════════════════════
// CRÉATION — RepairFamily
// ═══════════════════════════════════════════════════════════════════════════

test("creerFamille : cas nominal — écrit space, name (découpé) et sortOrder converti en nombre", async () => {
  BASE = base(); CAPTURES = captures();
  const res = fakeRes();

  await creerFamille({ body: { space: "APPLE", name: "  iPhone  ", sortOrder: "3" } }, res);

  assert.strictEqual(res.code, 201);
  assert.strictEqual(CAPTURES.familyCreates.length, 1, "un seul enregistrement doit être écrit");
  const data = CAPTURES.familyCreates[0];
  assert.strictEqual(data.space, "APPLE");
  assert.strictEqual(data.name, "iPhone", "les espaces superflus doivent être retirés");
  assert.strictEqual(data.sortOrder, 3, "sortOrder envoyé en chaîne doit être converti en nombre");
});

test("creerFamille : un nom vide ou absent est refusé, sans écriture", async () => {
  for (const name of [undefined, "   "]) {
    BASE = base(); CAPTURES = captures();
    const res = fakeRes();

    await creerFamille({ body: { space: "APPLE", name } }, res);

    assert.strictEqual(res.code, 400, `name=${JSON.stringify(name)} doit être refusé`);
    assert.strictEqual(CAPTURES.familyCreates.length, 0, "aucune famille ne doit être écrite sur un nom vide");
  }
});

test("creerFamille : un espace inconnu est refusé, sans écriture", async () => {
  BASE = base(); CAPTURES = captures();
  const res = fakeRes();

  await creerFamille({ body: { space: "GAMING", name: "Console" } }, res);

  assert.strictEqual(res.code, 400);
  assert.strictEqual(CAPTURES.familyCreates.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// CRÉATION — RepairModel
// ═══════════════════════════════════════════════════════════════════════════

test("creerModele : cas nominal — écrit familyId, name (découpé) et sortOrder converti", async () => {
  BASE = { ...base(), familles: [famille({ id: "fam-1", name: "iPhone", slug: "iphone" })] };
  CAPTURES = captures();
  const res = fakeRes();

  await creerModele({ body: { familyId: "fam-1", name: " iPhone 13 ", sortOrder: "5" } }, res);

  assert.strictEqual(res.code, 201);
  assert.strictEqual(CAPTURES.modelCreates.length, 1);
  const data = CAPTURES.modelCreates[0];
  assert.strictEqual(data.familyId, "fam-1");
  assert.strictEqual(data.name, "iPhone 13");
  assert.strictEqual(data.sortOrder, 5);
});

test("creerModele : un nom vide ou absent est refusé, sans écriture", async () => {
  for (const name of [undefined, "  "]) {
    BASE = { ...base(), familles: [famille({ id: "fam-1" })] };
    CAPTURES = captures();
    const res = fakeRes();

    await creerModele({ body: { familyId: "fam-1", name } }, res);

    assert.strictEqual(res.code, 400);
    assert.strictEqual(CAPTURES.modelCreates.length, 0);
  }
});

// Un `familyId` faux ne doit JAMAIS remonter comme une erreur de clé
// étrangère Prisma brute (illisible, en anglais) — le contrôleur vérifie
// l'existence explicitement AVANT d'écrire, précisément pour ça.
test("creerModele : une famille inexistante est refusée avec un message français, sans écriture", async () => {
  BASE = base(); CAPTURES = captures();
  const res = fakeRes();

  await creerModele({ body: { familyId: "fam-inconnue", name: "iPhone 13" } }, res);

  assert.strictEqual(res.code, 400);
  assert.strictEqual(res.corps.error, "Famille introuvable");
  assert.strictEqual(CAPTURES.modelCreates.length, 0);
});

test("creerModele : un familyId absent est refusé avant toute lecture de la famille", async () => {
  BASE = base(); CAPTURES = captures();
  const res = fakeRes();

  await creerModele({ body: { name: "iPhone 13" } }, res);

  assert.strictEqual(res.code, 400);
  assert.strictEqual(res.corps.error, "Famille requise");
  assert.strictEqual(CAPTURES.modelCreates.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// CRÉATION — RepairJob (la réparation)
// ═══════════════════════════════════════════════════════════════════════════

// Le test qui garantit qu'une réparation naît avec un prix : sans option
// "Standard" créée dans la même écriture, le catalogue public (`getModele`)
// l'écarterait silencieusement — l'administrateur la croirait publiée.
test("creerReparation : cas nominal — une option \"Standard\" est créée automatiquement avec le prix donné", async () => {
  BASE = { ...base(), modeles: [modele({ id: "mod-1", familyId: "fam-1", name: "iPhone 13" })] };
  CAPTURES = captures();
  const res = fakeRes();

  await creerReparation(
    { body: { modelId: "mod-1", name: " Écran cassé ", delay: "2h", price: 25000, sortOrder: "1" } },
    res,
  );

  assert.strictEqual(res.code, 201);
  assert.strictEqual(CAPTURES.jobCreates.length, 1);
  const data = CAPTURES.jobCreates[0];
  assert.strictEqual(data.modelId, "mod-1");
  assert.strictEqual(data.name, "Écran cassé");
  assert.strictEqual(data.delay, "2h");
  assert.strictEqual(data.sortOrder, 1);
  assert.ok(data.options && Array.isArray(data.options.create), "une option doit être créée dans la MÊME écriture");
  assert.strictEqual(data.options.create.length, 1, "exactement une option Standard, pas plus");
  assert.strictEqual(data.options.create[0].label, "Standard");
  assert.strictEqual(data.options.create[0].price, 25000, "l'option Standard doit porter le prix donné à la création");
});

test("creerReparation : un nom vide ou absent est refusé, sans écriture", async () => {
  for (const name of [undefined, "   "]) {
    BASE = { ...base(), modeles: [modele({ id: "mod-1" })] };
    CAPTURES = captures();
    const res = fakeRes();

    await creerReparation({ body: { modelId: "mod-1", name, price: 10000 } }, res);

    assert.strictEqual(res.code, 400);
    assert.strictEqual(CAPTURES.jobCreates.length, 0);
  }
});

test("creerReparation : un modèle inexistant est refusé avec un message français, sans écriture", async () => {
  BASE = base(); CAPTURES = captures();
  const res = fakeRes();

  await creerReparation({ body: { modelId: "mod-inconnu", name: "Écran cassé", price: 10000 } }, res);

  assert.strictEqual(res.code, 400);
  assert.strictEqual(res.corps.error, "Modèle introuvable");
  assert.strictEqual(CAPTURES.jobCreates.length, 0);
});

test("creerReparation : un prix non entier, négatif ou en chaîne non numérique est refusé, sans écriture", async () => {
  const prixInvalides = [99.9, -100, "abc"];
  for (const price of prixInvalides) {
    BASE = { ...base(), modeles: [modele({ id: "mod-1" })] };
    CAPTURES = captures();
    const res = fakeRes();

    await creerReparation({ body: { modelId: "mod-1", name: "Écran cassé", price } }, res);

    assert.strictEqual(res.code, 400, `price=${JSON.stringify(price)} doit être refusé`);
    assert.strictEqual(CAPTURES.jobCreates.length, 0, `price=${JSON.stringify(price)} ne doit rien écrire`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CRÉATION — RepairOption (la qualité de pièce, qui porte le prix)
// ═══════════════════════════════════════════════════════════════════════════

test("creerOption : cas nominal — écrit jobId, label (découpé), price et sortOrder", async () => {
  BASE = { ...base(), jobs: [job({ id: "job-1", modelId: "mod-1" })] };
  CAPTURES = captures();
  const res = fakeRes();

  await creerOption({ body: { jobId: "job-1", label: " Origine ", price: 35000, sortOrder: "2" } }, res);

  assert.strictEqual(res.code, 201);
  assert.strictEqual(CAPTURES.optionCreates.length, 1);
  const data = CAPTURES.optionCreates[0];
  assert.strictEqual(data.jobId, "job-1");
  assert.strictEqual(data.label, "Origine");
  assert.strictEqual(data.price, 35000);
  assert.strictEqual(data.sortOrder, 2);
});

test("creerOption : un libellé vide ou absent est refusé, sans écriture", async () => {
  for (const label of [undefined, "  "]) {
    BASE = { ...base(), jobs: [job({ id: "job-1" })] };
    CAPTURES = captures();
    const res = fakeRes();

    await creerOption({ body: { jobId: "job-1", label, price: 10000 } }, res);

    assert.strictEqual(res.code, 400);
    assert.strictEqual(CAPTURES.optionCreates.length, 0);
  }
});

test("creerOption : une réparation inexistante est refusée avec un message français, sans écriture", async () => {
  BASE = base(); CAPTURES = captures();
  const res = fakeRes();

  await creerOption({ body: { jobId: "job-inconnu", label: "Origine", price: 10000 } }, res);

  assert.strictEqual(res.code, 400);
  assert.strictEqual(res.corps.error, "Réparation introuvable");
  assert.strictEqual(CAPTURES.optionCreates.length, 0);
});

test("creerOption : un prix non entier, négatif ou en chaîne non numérique est refusé, sans écriture", async () => {
  const prixInvalides = [99.9, -100, "abc"];
  for (const price of prixInvalides) {
    BASE = { ...base(), jobs: [job({ id: "job-1" })] };
    CAPTURES = captures();
    const res = fakeRes();

    await creerOption({ body: { jobId: "job-1", label: "Origine", price } }, res);

    assert.strictEqual(res.code, 400, `price=${JSON.stringify(price)} doit être refusé`);
    assert.strictEqual(CAPTURES.optionCreates.length, 0);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SLUG
// ═══════════════════════════════════════════════════════════════════════════

test("creerFamille : deux familles de même nom produisent des slugs différents (iphone, puis iphone-2)", async () => {
  BASE = base(); CAPTURES = captures();

  await creerFamille({ body: { space: "APPLE", name: "iPhone" } }, fakeRes());
  await creerFamille({ body: { space: "APPLE", name: "iPhone" } }, fakeRes());

  assert.strictEqual(CAPTURES.familyCreates.length, 2);
  assert.strictEqual(CAPTURES.familyCreates[0].slug, "iphone");
  assert.strictEqual(
    CAPTURES.familyCreates[1].slug, "iphone-2",
    "le second nom identique doit recevoir un suffixe plutôt que de collisionner",
  );
});

test("creerFamille : un nom sans caractère latin produit tout de même un slug non vide", async () => {
  BASE = base(); CAPTURES = captures();
  const res = fakeRes();

  await creerFamille({ body: { space: "APPLE", name: "★★★" } }, res);

  assert.strictEqual(res.code, 201);
  const slug = CAPTURES.familyCreates[0].slug;
  assert.ok(typeof slug === "string" && slug.length > 0, "un slug non vide doit toujours être écrit, même sans caractère latin exploitable");
});

// ═══════════════════════════════════════════════════════════════════════════
// MODIFICATION — les quatre niveaux
// ═══════════════════════════════════════════════════════════════════════════

test("modifierFamille : seuls les champs envoyés dans le corps sont écrits", async () => {
  BASE = { ...base(), familles: [famille({ id: "fam-1", sortOrder: 0, active: true })] };
  CAPTURES = captures();
  const res = fakeRes();

  await modifierFamille({ params: { id: "fam-1" }, body: { name: "Nouveau nom" } }, res);

  assert.strictEqual(res.code, 200);
  const data = CAPTURES.familyUpdates[0];
  assert.deepStrictEqual(
    Object.keys(data).sort(), ["name"],
    "sortOrder et active n'étaient pas dans le corps — ils ne doivent pas figurer dans l'écriture",
  );
});

test("modifierFamille : active:false désactive la famille", async () => {
  BASE = { ...base(), familles: [famille({ id: "fam-1", active: true })] };
  CAPTURES = captures();
  const res = fakeRes();

  await modifierFamille({ params: { id: "fam-1" }, body: { active: false } }, res);

  assert.strictEqual(CAPTURES.familyUpdates[0].active, false);
  assert.strictEqual(res.corps.famille.active, false);
});

test("modifierModele : seuls les champs envoyés dans le corps sont écrits", async () => {
  BASE = { ...base(), modeles: [modele({ id: "mod-1" })] };
  CAPTURES = captures();
  const res = fakeRes();

  await modifierModele({ params: { id: "mod-1" }, body: { sortOrder: 4 } }, res);

  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(Object.keys(CAPTURES.modelUpdates[0]), ["sortOrder"]);
});

test("modifierModele : active:false désactive le modèle", async () => {
  BASE = { ...base(), modeles: [modele({ id: "mod-1", active: true })] };
  CAPTURES = captures();
  const res = fakeRes();

  await modifierModele({ params: { id: "mod-1" }, body: { active: false } }, res);

  assert.strictEqual(CAPTURES.modelUpdates[0].active, false);
  assert.strictEqual(res.corps.modele.active, false);
});

// Pas de prix ici : le prix vit sur les options, jamais sur la réparation.
test("modifierReparation : seuls les champs envoyés dans le corps sont écrits", async () => {
  BASE = { ...base(), jobs: [job({ id: "job-1", modelId: "mod-1" })] };
  CAPTURES = captures();
  const res = fakeRes();

  await modifierReparation({ params: { id: "job-1" }, body: { delay: "1h" } }, res);

  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(Object.keys(CAPTURES.jobUpdates[0]), ["delay"]);
});

test("modifierReparation : active:false désactive la réparation", async () => {
  BASE = { ...base(), jobs: [job({ id: "job-1", modelId: "mod-1", active: true })] };
  CAPTURES = captures();
  const res = fakeRes();

  await modifierReparation({ params: { id: "job-1" }, body: { active: false } }, res);

  assert.strictEqual(CAPTURES.jobUpdates[0].active, false);
  assert.strictEqual(res.corps.reparation.active, false);
});

test("modifierOption : seuls les champs envoyés dans le corps sont écrits", async () => {
  BASE = { ...base(), options: [optionRow({ id: "opt-1", jobId: "job-1" })] };
  CAPTURES = captures();
  const res = fakeRes();

  await modifierOption({ params: { id: "opt-1" }, body: { label: "Compatible" } }, res);

  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(Object.keys(CAPTURES.optionUpdates[0]), ["label"]);
});

test("modifierOption : active:false désactive l'option", async () => {
  BASE = { ...base(), options: [optionRow({ id: "opt-1", jobId: "job-1", active: true })] };
  CAPTURES = captures();
  const res = fakeRes();

  await modifierOption({ params: { id: "opt-1" }, body: { active: false } }, res);

  assert.strictEqual(CAPTURES.optionUpdates[0].active, false);
  assert.strictEqual(res.corps.option.active, false);
});

test("modifierOption : un prix invalide fourni en modification est refusé, sans écriture", async () => {
  BASE = { ...base(), options: [optionRow({ id: "opt-1", jobId: "job-1", price: 20000 })] };
  CAPTURES = captures();
  const res = fakeRes();

  await modifierOption({ params: { id: "opt-1" }, body: { price: -5 } }, res);

  assert.strictEqual(res.code, 400);
  assert.strictEqual(CAPTURES.optionUpdates.length, 0, "un prix invalide ne doit déclencher aucune écriture");
});

// ═══════════════════════════════════════════════════════════════════════════
// SUPPRESSION — les quatre niveaux
// ═══════════════════════════════════════════════════════════════════════════

test("supprimerFamille : supprime bien l'identifiant demandé, et lui seul", async () => {
  BASE = { ...base(), familles: [famille({ id: "fam-1" }), famille({ id: "fam-2", name: "Samsung" })] };
  CAPTURES = captures();
  const res = fakeRes();

  await supprimerFamille({ params: { id: "fam-1" } }, res);

  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(CAPTURES.familyDeletes, ["fam-1"]);
  assert.ok(!BASE.familles.some((f) => f.id === "fam-1"));
  assert.ok(BASE.familles.some((f) => f.id === "fam-2"), "un autre enregistrement ne doit pas être touché");
});

test("supprimerModele : supprime bien l'identifiant demandé, et lui seul", async () => {
  BASE = { ...base(), modeles: [modele({ id: "mod-1" }), modele({ id: "mod-2", name: "iPhone 14" })] };
  CAPTURES = captures();
  const res = fakeRes();

  await supprimerModele({ params: { id: "mod-1" } }, res);

  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(CAPTURES.modelDeletes, ["mod-1"]);
  assert.ok(BASE.modeles.some((m) => m.id === "mod-2"));
});

test("supprimerReparation : supprime bien l'identifiant demandé, et lui seul", async () => {
  BASE = { ...base(), jobs: [job({ id: "job-1", modelId: "mod-1" }), job({ id: "job-2", modelId: "mod-1", name: "Batterie" })] };
  CAPTURES = captures();
  const res = fakeRes();

  await supprimerReparation({ params: { id: "job-1" } }, res);

  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(CAPTURES.jobDeletes, ["job-1"]);
  assert.ok(BASE.jobs.some((j) => j.id === "job-2"));
});

test("supprimerOption : supprime bien l'identifiant demandé, et lui seul", async () => {
  BASE = {
    ...base(),
    options: [optionRow({ id: "opt-1", jobId: "job-1" }), optionRow({ id: "opt-2", jobId: "job-1", label: "Origine" })],
  };
  CAPTURES = captures();
  const res = fakeRes();

  await supprimerOption({ params: { id: "opt-1" } }, res);

  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(CAPTURES.optionDeletes, ["opt-1"]);
  assert.ok(BASE.options.some((o) => o.id === "opt-2"));
});

// ═══════════════════════════════════════════════════════════════════════════
// DUPLICATION — dupliquerReparation
// ═══════════════════════════════════════════════════════════════════════════

test("dupliquerReparation : copie la réparation et ses options vers chaque modèle cible", async () => {
  BASE = {
    familles: [],
    modeles: [
      modele({ id: "mod-src", name: "iPhone 13" }),
      modele({ id: "mod-a", name: "iPhone 14" }),
      modele({ id: "mod-b", name: "iPhone 15" }),
    ],
    jobs: [job({ id: "job-src", modelId: "mod-src", name: "Écran cassé", delay: "2h", sortOrder: 1 })],
    options: [
      optionRow({ id: "opt-1", jobId: "job-src", label: "Standard", price: 20000, sortOrder: 0 }),
      optionRow({ id: "opt-2", jobId: "job-src", label: "Origine", price: 35000, sortOrder: 1 }),
    ],
  };
  CAPTURES = captures();
  const res = fakeRes();

  await dupliquerReparation({ params: { id: "job-src" }, body: { modelIds: ["mod-a", "mod-b"] } }, res);

  assert.strictEqual(res.code, 200);
  assert.strictEqual(CAPTURES.jobCreates.length, 2, "une copie doit être créée par modèle cible");
  assert.strictEqual(res.corps.copiees, 2);
  for (const data of CAPTURES.jobCreates) {
    assert.strictEqual(data.name, "Écran cassé");
    assert.strictEqual(data.delay, "2h");
    assert.strictEqual(data.sortOrder, 1);
    assert.ok(data.options?.create, "les options doivent être copiées AVEC la réparation, dans la même écriture");
    assert.strictEqual(data.options.create.length, 2);
    assert.deepStrictEqual(data.options.create.map((o) => o.label).sort(), ["Origine", "Standard"]);
    assert.deepStrictEqual(data.options.create.map((o) => o.price).sort((a, b) => a - b), [20000, 35000]);
  }
});

test("dupliquerReparation : ignore le modèle source s'il figure dans les cibles", async () => {
  BASE = {
    familles: [],
    modeles: [modele({ id: "mod-src" }), modele({ id: "mod-a", name: "iPhone 14" })],
    jobs: [job({ id: "job-src", modelId: "mod-src" })],
    options: [optionRow({ id: "opt-1", jobId: "job-src" })],
  };
  CAPTURES = captures();
  const res = fakeRes();

  await dupliquerReparation({ params: { id: "job-src" }, body: { modelIds: ["mod-src", "mod-a"] } }, res);

  assert.strictEqual(res.code, 200);
  assert.strictEqual(CAPTURES.jobCreates.length, 1, "le modèle source ne doit pas recevoir une copie de lui-même");
  assert.strictEqual(CAPTURES.jobCreates[0].modelId, "mod-a");
  assert.strictEqual(res.corps.copiees, 1);
});

test("dupliquerReparation : un modelIds contenant un doublon ne produit qu'une seule copie", async () => {
  BASE = {
    familles: [],
    modeles: [modele({ id: "mod-src" }), modele({ id: "mod-a", name: "iPhone 14" })],
    jobs: [job({ id: "job-src", modelId: "mod-src" })],
    options: [optionRow({ id: "opt-1", jobId: "job-src" })],
  };
  CAPTURES = captures();
  const res = fakeRes();

  await dupliquerReparation({ params: { id: "job-src" }, body: { modelIds: ["mod-a", "mod-a"] } }, res);

  assert.strictEqual(CAPTURES.jobCreates.length, 1, "un identifiant répété ne doit pas produire deux copies");
  assert.strictEqual(res.corps.copiees, 1);
});

test("dupliquerReparation : une cible inexistante est refusée, sans aucune écriture", async () => {
  BASE = {
    familles: [],
    modeles: [modele({ id: "mod-src" })],
    jobs: [job({ id: "job-src", modelId: "mod-src" })],
    options: [optionRow({ id: "opt-1", jobId: "job-src" })],
  };
  CAPTURES = captures();
  const res = fakeRes();

  await dupliquerReparation({ params: { id: "job-src" }, body: { modelIds: ["mod-inconnu"] } }, res);

  assert.strictEqual(res.code, 400);
  assert.strictEqual(CAPTURES.jobCreates.length, 0, "aucune copie ne doit être écrite si une seule cible est introuvable");
});

test("dupliquerReparation : une liste de cibles vide est refusée", async () => {
  BASE = {
    familles: [],
    modeles: [modele({ id: "mod-src" })],
    jobs: [job({ id: "job-src", modelId: "mod-src" })],
    options: [optionRow({ id: "opt-1", jobId: "job-src" })],
  };
  CAPTURES = captures();
  const res = fakeRes();

  await dupliquerReparation({ params: { id: "job-src" }, body: { modelIds: [] } }, res);

  assert.strictEqual(res.code, 400);
  assert.strictEqual(CAPTURES.jobCreates.length, 0);
});

// L'intérêt de COPIER plutôt que de partager : changer le prix d'une copie ne
// doit jamais pouvoir affecter la source. Ce test vérifie que la duplication
// crée de véritables nouvelles lignes d'options (nouvel id, nouveau jobId),
// jamais une référence vers celles de la source.
test("dupliquerReparation : les copies sont indépendantes — nouvelles lignes d'options, pas des références à la source", async () => {
  BASE = {
    familles: [],
    modeles: [modele({ id: "mod-src" }), modele({ id: "mod-a", name: "iPhone 14" })],
    jobs: [job({ id: "job-src", modelId: "mod-src" })],
    options: [optionRow({ id: "opt-src", jobId: "job-src", price: 20000 })],
  };
  CAPTURES = captures();
  const res = fakeRes();

  await dupliquerReparation({ params: { id: "job-src" }, body: { modelIds: ["mod-a"] } }, res);

  // Ce qui est ENVOYÉ à Prisma ne doit porter aucun `id` recopié de la
  // source — c'est Prisma qui doit en attribuer un nouveau.
  const optionEnvoyee = CAPTURES.jobCreates[0].options.create[0];
  assert.strictEqual(optionEnvoyee.id, undefined, "la donnée envoyée ne doit pas porter l'id de l'option source");

  // Une fois « écrites » (le bouchon simule l'attribution d'id de Prisma), il
  // doit exister DEUX lignes distinctes, chacune rattachée à son propre job —
  // pas une seule ligne partagée entre la source et la copie.
  const optionsMemePrix = BASE.options.filter((o) => o.price === 20000);
  assert.strictEqual(optionsMemePrix.length, 2, "la duplication doit créer une DEUXIÈME ligne d'option, pas partager la première");
  assert.notStrictEqual(optionsMemePrix[0].id, optionsMemePrix[1].id);
  const jobIdsDistincts = new Set(optionsMemePrix.map((o) => o.jobId));
  assert.strictEqual(jobIdsDistincts.size, 2, "chaque copie doit avoir sa propre réparation cible, pas partager celle de la source");
});

// ═══════════════════════════════════════════════════════════════════════════
// LECTURES
// ═══════════════════════════════════════════════════════════════════════════

test("getModele : une réparation dont toutes les options sont désactivées est écartée du catalogue public", async () => {
  BASE = {
    familles: [famille({ id: "fam-1", name: "iPhone", slug: "iphone", active: true })],
    modeles: [modele({ id: "mod-1", familyId: "fam-1", name: "iPhone 13", slug: "iphone-13" })],
    jobs: [
      job({ id: "job-avec-prix", modelId: "mod-1", name: "Écran cassé" }),
      job({ id: "job-sans-prix", modelId: "mod-1", name: "Batterie" }),
    ],
    options: [
      optionRow({ id: "opt-1", jobId: "job-avec-prix", price: 20000, active: true }),
      // Seule option de cette réparation, mais désactivée : sans prix
      // affichable, la réparation n'est pas commandable.
      optionRow({ id: "opt-2", jobId: "job-sans-prix", price: 15000, active: false }),
    ],
  };
  CAPTURES = captures();
  const res = fakeRes();

  await getModele({ params: { slug: "iphone-13" } }, res);

  assert.strictEqual(res.code, 200);
  const noms = res.corps.reparations.map((r) => r.name);
  assert.ok(noms.includes("Écran cassé"), "une réparation avec une option active doit rester visible");
  assert.ok(!noms.includes("Batterie"), "une réparation sans AUCUNE option active ne doit pas apparaître au public");
});

// L'écran d'administration, à l'inverse du catalogue public, doit tout
// montrer : c'est là que l'administrateur va réactiver ou vérifier ce qu'il a
// coupé.
test("getCatalogueAdmin : rend l'actif ET l'inactif à tous les niveaux", async () => {
  BASE = {
    familles: [
      famille({ id: "fam-1", space: "APPLE", active: true }),
      famille({ id: "fam-2", name: "Samsung", space: "APPLE", active: false }),
    ],
    modeles: [modele({ id: "mod-1", familyId: "fam-1", active: false })],
    jobs: [job({ id: "job-1", modelId: "mod-1", active: false })],
    options: [optionRow({ id: "opt-1", jobId: "job-1", active: false })],
  };
  CAPTURES = captures();
  const res = fakeRes();

  await getCatalogueAdmin({ query: { espace: "APPLE" } }, res);

  assert.strictEqual(res.code, 200);
  const ids = res.corps.familles.map((f) => f.id);
  assert.ok(ids.includes("fam-1"));
  assert.ok(ids.includes("fam-2"), "une famille désactivée doit rester visible dans l'écran de gestion");

  const fam1 = res.corps.familles.find((f) => f.id === "fam-1");
  assert.strictEqual(fam1.models.length, 1, "un modèle désactivé doit rester visible");
  assert.strictEqual(fam1.models[0].jobs.length, 1, "une réparation désactivée doit rester visible");
  assert.strictEqual(fam1.models[0].jobs[0].options.length, 1, "une option désactivée doit rester visible");
});

test("rechercherModeles : un espace inconnu est refusé", async () => {
  BASE = base(); CAPTURES = captures();
  const res = fakeRes();

  await rechercherModeles({ query: { espace: "GAMING", q: "iphone" } }, res);

  assert.strictEqual(res.code, 400);
});

test("rechercherModeles : une recherche de moins de deux caractères rend une liste vide", async () => {
  BASE = { ...base(), familles: [famille({ id: "fam-1", space: "APPLE" })], modeles: [modele({ id: "mod-1", familyId: "fam-1", name: "iPhone 13" })] };
  CAPTURES = captures();
  const res = fakeRes();

  await rechercherModeles({ query: { espace: "APPLE", q: "i" } }, res);

  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(res.corps.modeles, [], "une recherche trop courte ne doit rendre aucun résultat");
});

// ── Lectures publiques restantes — exercées a minima pour couvrir les quatre
// niveaux de bout en bout, au-delà des cas déjà creusés ci-dessus.
test("getFamilles : ne rend que les familles actives de l'espace demandé", async () => {
  BASE = {
    ...base(),
    familles: [
      famille({ id: "fam-1", space: "APPLE", active: true }),
      famille({ id: "fam-2", name: "Samsung", space: "APPLE", active: false }),
    ],
  };
  CAPTURES = captures();
  const res = fakeRes();

  await getFamilles({ query: { espace: "APPLE" } }, res);

  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(res.corps.familles.map((f) => f.id), ["fam-1"], "une famille désactivée ne doit pas apparaître au public");
});

test("getModelesDeFamille : ne rend que les modèles actifs de la famille désignée par le slug", async () => {
  BASE = {
    ...base(),
    familles: [famille({ id: "fam-1", slug: "iphone", active: true })],
    modeles: [
      modele({ id: "mod-1", familyId: "fam-1", active: true }),
      modele({ id: "mod-2", familyId: "fam-1", name: "iPhone SE", active: false }),
    ],
  };
  CAPTURES = captures();
  const res = fakeRes();

  await getModelesDeFamille({ params: { slug: "iphone" } }, res);

  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(res.corps.modeles.map((m) => m.id), ["mod-1"]);
});
