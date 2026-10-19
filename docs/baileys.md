# Intégrer Baileys correctement

Guide d'intégration de `@whiskeysockets/baileys` dans un projet Node.js, tiré
d'une mise en production réelle. Chaque avertissement correspond à une panne qui
a effectivement eu lieu.

**Lisez la section « Les sept pièges » avant d'écrire la moindre ligne.** Six
d'entre eux ne produisent aucune erreur : le code fonctionne, et échoue
ailleurs, plus tard, sans rien dire.

---

## 0. Ce que Baileys est, et n'est pas

Baileys n'est **pas un service** et n'a **pas d'API officielle**. C'est une
bibliothèque qui parle le protocole de WhatsApp Web, avec **votre numéro**,
apparié par QR code. Votre serveur devient un appareil lié, exactement comme un
navigateur sur `web.whatsapp.com`.

Trois conséquences structurantes, à accepter avant de commencer :

| | |
|---|---|
| **Gratuit** | aucun abonnement, aucun coût par message |
| **Non officiel** | Meta ne le documente ni ne le soutient ; un numéro qui envoie beaucoup de messages non sollicités **peut être banni sans préavis ni recours** |
| **Une seule instance** | deux processus sur le même numéro se déconnectent mutuellement, en boucle |

Si le volume grandit au point que perdre le numéro devienne inacceptable, la
seule alternative est la **WhatsApp Business Platform** de Meta : payante,
gabarits à faire approuver à l'avance, mais sans risque de bannissement.

---

## 1. Installation

```bash
npm i @whiskeysockets/baileys @hapi/boom pino qrcode
```

`@hapi/boom` sert à lire le code de déconnexion, `pino` est le journal qu'exige
Baileys, `qrcode` sert à afficher ou servir le QR d'appairage.

**Figez la version.** Baileys suit les changements de WhatsApp et publie
essentiellement des *release candidates* ; un `^` vous expose à une mise à jour
qui casse la session en production.

```json
"@whiskeysockets/baileys": "7.0.0-rc13"
```

---

## 2. Le socle minimal qui fonctionne

```js
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");

const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || "./whatsapp-session";
let sock = null;
let isReady = false;

async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: require("pino")({ level: "silent" }),
    browser: ["MonApp", "Chrome", "1.0.0"],
    connectTimeoutMs: 60_000,
    retryRequestDelayMs: 2_000,
    keepAliveIntervalMs: 30_000,
    markOnlineOnConnect: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Ne l'affichez pas seulement dans le terminal : sur un serveur, personne
      // ne le voit. Exposez-le sur une route protégée par un jeton.
      global.lastQR = qr;
    }

    if (connection === "open") {
      isReady = true;
      global.lastQR = null;
    }

    if (connection === "close") {
      isReady = false;
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        // Sans retour possible : la session est morte côté téléphone. Aucune
        // reconnexion ne la rattrapera. Effacez tout et prévenez un humain.
        await detruireSession();
        setTimeout(initWhatsApp, 3_000);
      } else {
        setTimeout(initWhatsApp, code === 408 ? 10_000 : 5_000);
      }
    }
  });
}
```

`printQRInTerminal` est déprécié dans Baileys 7 : gérez le QR vous-même via
l'événement.

---

## 3. Les sept pièges

### Piège 1 — Le disque n'est pas persistant

`useMultiFileAuthState` écrit des fichiers. Sur Render, Heroku, Fly, Cloud Run,
ces fichiers **disparaissent à chaque déploiement** : chaque mise en production
redemande un QR.

La parade est de conserver la session **aussi en base**, et de la restaurer au
démarrage.

```js
async function sauvegarderSessionEnBase() {
  if (!fs.existsSync(SESSION_PATH)) return;

  const data = {};
  for (const fichier of fs.readdirSync(SESSION_PATH)) {
    const contenu = fs.readFileSync(path.join(SESSION_PATH, fichier), "utf-8");
    try {
      data[fichier] = JSON.parse(contenu);
    } catch {
      // Fichier saisi PENDANT que Baileys l'écrit. L'enregistrer tel quel a
      // déjà empoisonné une session : creds.json s'est retrouvé stocké comme
      // chaîne vide, et le serveur repartait ensuite d'une identité neuve tout
      // en héritant des clés de l'ancienne. On garde la version précédente.
      continue;
    }
  }

  // Sans identité valide, ne PAS écrire : on écraserait la dernière bonne
  // version par un état inutilisable.
  if (!data["creds.json"] || typeof data["creds.json"] !== "object") return;

  await prisma.whatsAppSession.upsert({
    where: { id: "main" },
    update: { data },
    create: { id: "main", data },
    select: { id: true },   // voir Piège 3
  });
}
```

> **Sur un VPS, ne pointez pas `WHATSAPP_SESSION_PATH` vers `/tmp`.**
> `systemd-tmpfiles` le purge périodiquement, y compris pendant que le service
> tourne. Utilisez un dossier persistant, ou un volume Docker.

### Piège 2 — Le chargement n'efface pas le dossier

La restauration écrit les fichiers de la base **par-dessus** ceux du disque.
Elle ne supprime rien.

Conséquence directe : **supprimer des fichiers de session sur le disque ne sert
à rien**, ils reviennent au premier redémarrage. Pour élaguer réellement, il
faut supprimer sur le disque *puis* provoquer une sauvegarde (voir Piège 6)
avant le redémarrage.

```js
async function chargerSessionDepuisBase() {
  const ligne = await prisma.whatsAppSession.findUnique({ where: { id: "main" } });
  if (!ligne) return false;

  const data = ligne.data || {};

  // Une session sans identité exploitable ne se restaure pas : Baileys
  // repartirait d'une identité neuve tout en héritant de milliers de clés de
  // l'ancienne. L'appairage semble alors réussir sur le téléphone puis retombe
  // aussitôt — un QR durablement inopérant, sans message d'erreur.
  if (!data["creds.json"] || typeof data["creds.json"] !== "object") {
    await prisma.whatsAppSession.deleteMany({ where: { id: "main" } });
    return false;
  }

  fs.mkdirSync(SESSION_PATH, { recursive: true });
  for (const [fichier, contenu] of Object.entries(data)) {
    fs.writeFileSync(
      path.join(SESSION_PATH, fichier),
      typeof contenu === "string" ? contenu : JSON.stringify(contenu),
      "utf-8",
    );
  }
  return true;
}
```

### Piège 3 — `creds.update` ruine votre quota de base

`creds.update` se déclenche **des centaines de fois par heure** : une fois par
message envoyé ou reçu, plus les rotations de clés. Écrire la session en base à
chaque fois, c'est des gigaoctets de trafic par mois.

Trois gardes, et les trois sont nécessaires :

```js
let _minuteur = null;
let _derniereEmpreinte = null;

// 1) Étalement : au plus une écriture toutes les 30 secondes.
function planifierSauvegarde() {
  if (_minuteur) return;
  _minuteur = setTimeout(async () => {
    _minuteur = null;
    await sauvegarderSessionEnBase();
  }, 30_000);
}

// 2) Empreinte : ne pas réécrire un contenu identique. Baileys déclenche
//    creds.update très souvent sans que le contenu diffère toujours.
const empreinte = JSON.stringify(data);
if (empreinte === _derniereEmpreinte) return;
_derniereEmpreinte = empreinte;

// 3) `select` sur l'upsert : sans lui, Postgres RENVOIE la ligne entière —
//    c'est-à-dire les mégaoctets qu'on vient d'écrire, qui repartent aussitôt
//    dans l'autre sens.
```

L'écriture locale, elle, reste immédiate :

```js
sock.ev.on("creds.update", async () => {
  await saveCreds();        // disque : immédiat
  planifierSauvegarde();    // base : étalé
});
```

> Si vous effacez la ligne en base, **remettez `_derniereEmpreinte` à `null`**.
> Sinon, une session reconstruite identique déclencherait la garde
> anti-réécriture, et la ligne supprimée ne serait jamais recréée.

### Piège 4 — L'adressage `@lid` casse tout, en silence

Baileys 7 livre un message individuel sous **deux formes** selon le mode négocié
par le serveur :

| `remoteJid` | signification |
|---|---|
| `22997437551@s.whatsapp.net` | le numéro est dans le JID |
| `123456789012345@lid` | identifiant **masqué** : ces chiffres ne sont pas un numéro |

Sur un `@lid`, le vrai numéro arrive — quand il est connu — dans
`key.remoteJidAlt`.

Confondre les deux ne lève aucune erreur. Un LID fait plus de huit chiffres,
donc toute normalisation naïve l'accepte ; aucun client ne lui correspond en
base, et la réponse repart vers `<chiffres du LID>@s.whatsapp.net`, une adresse
qui n'existe pas. **Personne ne reçoit rien et rien ne l'explique.**

Rendez donc **deux valeurs, jamais interchangeables** :

```js
function extraireAdressage(key) {
  const remoteJid = key?.remoteJid;
  if (!remoteJid || typeof remoteJid !== "string") return null;

  // `adresse` : à réutiliser TEL QUEL pour répondre. Ne la reconstruisez
  //             JAMAIS à partir de ses chiffres.
  // `numero`  : la valeur à rapprocher de vos enregistrements.
  if (!remoteJid.endsWith("@lid")) {
    return { adresse: remoteJid, numero: remoteJid, masque: false };
  }

  const alt = key?.remoteJidAlt;
  if (!alt || typeof alt !== "string") return null;  // rien d'exploitable

  return { adresse: remoteJid, numero: alt, masque: true };
}
```

Prévoyez **deux chemins d'envoi** : `sendMessage(numero, texte)` qui normalise,
et `sendMessageToJid(jid, texte)` qui n'y touche pas. Répondre à un message
entrant passe toujours par le second.

Journalisez la forme réellement observée, une fois au démarrage :

```js
logger.info("Adressage constaté", {
  addressingMode: msg.key?.addressingMode ?? "(absent)",
  forme: jid.endsWith("@lid") ? "lid" : "jid",
  remoteJidAlt: msg.key?.remoteJidAlt ? "présent" : "absent",
});
```

Sans cette ligne, un routage muet par LID est indistinguable d'un client qui
n'écrit pas.

### Piège 5 — L'arriéré rejoué à la reconnexion

À chaque reconnexion, WhatsApp **rejoue les messages non traités**, et ils
arrivent avec `type: "notify"` — exactement comme des messages frais.

Si un message déclenche une action (ouvrir une demande, envoyer un code,
enregistrer une commande), un message vieux de deux jours déclenchera cette
action **maintenant**.

```js
const TOLERANCE_MS = 5 * 60 * 1000;

// `messageTimestamp` arrive tantôt en secondes, tantôt en `Long` protobuf
// ({ low, high } ou porteur d'un toNumber()), tantôt en chaîne, tantôt pas du
// tout. Rendre null sur ce qu'on ne sait pas lire est volontaire.
function horodatageMs(brut) {
  if (brut === null || brut === undefined) return null;
  let s = null;
  if (typeof brut === "number") s = brut;
  else if (typeof brut === "bigint") s = Number(brut);
  else if (typeof brut === "string") s = Number(brut);
  else if (typeof brut.toNumber === "function") { try { s = brut.toNumber(); } catch { return null; } }
  else if (typeof brut.low === "number") s = brut.low + (Number(brut.high) || 0) * 4294967296;
  if (s === null || !Number.isFinite(s) || s <= 0) return null;
  return s * 1000;
}

function messageTropAncien(brut, maintenant = Date.now()) {
  const ms = horodatageMs(brut);
  if (ms === null) return false;   // horodatage illisible : on ne jette pas
  return maintenant - ms > TOLERANCE_MS;
}
```

Cinq minutes : assez large pour la dérive d'horloge et les micro-coupures,
assez serré pour écarter l'arriéré.

### Piège 6 — L'arrêt brutal perd la dernière rotation de clé

Un redéploiement envoie `SIGTERM`. Si une rotation de clé Baileys vient de se
produire et n'a pas encore franchi l'étalement de 30 secondes, elle est perdue —
et la session peut devenir invalide.

```js
async function viderFileSauvegarde() {
  if (_minuteur) { clearTimeout(_minuteur); _minuteur = null; }
  await sauvegarderSessionEnBase();
}

async function arret(signal) {
  try { await viderFileSauvegarde(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => arret("SIGTERM"));
process.on("SIGINT",  () => arret("SIGINT"));
```

Accordez un délai de grâce suffisant à l'orchestrateur — l'écriture doit
atteindre la base :

```yaml
stop_grace_period: 40s
```

### Piège 7 — Les alertes de déconnexion inondent la boîte mail

Une session invalide produit ce profil : Baileys se connecte, se fait
déconnecter aussitôt, recommence trois secondes plus tard. Un simple drapeau
« alerte déjà envoyée », remis à zéro sur `connection === "open"`, se réarme à
chaque cycle. Mesuré en production : **jusqu'à vingt courriels par minute**.

Il faut **deux verrous**, pas un :

```js
let _alerteEnvoyee = false;
let _derniereAlerte = 0;
let _minuteurRearmement = null;

const INTERVALLE_MIN_MS = 60 * 60 * 1000;      // filet indépendant du drapeau
const STABILITE_MS      =  5 * 60 * 1000;      // une connexion doit TENIR

if (connection === "open") {
  // La panne n'est pas finie parce qu'une connexion s'ouvre : elle est finie
  // quand la connexion tient. On réarme donc en différé.
  clearTimeout(_minuteurRearmement);
  _minuteurRearmement = setTimeout(() => { _alerteEnvoyee = false; }, STABILITE_MS);
  _minuteurRearmement.unref?.();   // ne doit pas maintenir le process en vie
}

if (connection === "close") {
  clearTimeout(_minuteurRearmement);   // la connexion n'aura pas tenu
}

function alerter(sujet, corps) {
  const maintenant = Date.now();
  if (_alerteEnvoyee) return;
  if (maintenant - _derniereAlerte < INTERVALLE_MIN_MS) return;  // le vrai filet
  _alerteEnvoyee = true;
  _derniereAlerte = maintenant;
  envoyerEmail(sujet, corps);
}
```

**L'alerte doit partir par un autre canal que WhatsApp** — c'est précisément
WhatsApp qui est tombé.

---

## 4. Messages entrants : trois filtres obligatoires

```js
sock.ev.on("messages.upsert", async ({ messages, type }) => {
  if (type !== "notify") return;

  for (const msg of messages) {
    const jid = msg.key?.remoteJid;

    if (!jid || msg.key?.fromMe) continue;      // sinon le bot se répond en boucle
    if (jid.endsWith("@g.us")) continue;        // un bot qui parle en groupe est intrusif
    if (messageTropAncien(msg.messageTimestamp)) continue;   // Piège 5

    const adressage = extraireAdressage(msg.key);            // Piège 4
    if (!adressage) continue;

    // ... votre logique, déclenchée par un MOT-CLÉ explicite.
  }
});
```

Le mot-clé compte : ce numéro sert aussi au service client. Un bot qui répond à
tout parasite les conversations humaines.

**Rapprocher un numéro entrant de vos enregistrements** demande une comparaison
tolérante : le même client apparaît tantôt en `97437551`, tantôt en
`22997437551`. Comparez sur les derniers chiffres significatifs, jamais sur
l'égalité stricte.

---

## 5. La session grossit — beaucoup

Après quelques mois et quelques centaines de contacts, mesuré en production :
**27 800 fichiers**, 11,7 Mo de données réelles, ~112 Mo occupés sur le disque
(des milliers de fichiers minuscules, un bloc chacun).

| famille | rôle | supprimable ? |
|---|---|---|
| `creds.json` | l'identité | **jamais** — perte = nouveau QR |
| `app-state-sync-*` | synchronisation | **jamais** |
| `session-*`, `identity-key-*` | chiffrement par contact | non — échec de déchiffrement avec ce contact |
| `pre-key-*` | ouverture de session par un **nouveau** contact | non — le serveur les annonce déjà |
| `lid-mapping-*` | correspondance identifiant masqué ↔ numéro | à éviter — casse la réponse aux entrants |
| `sender-key-status@broadcast_*` | déchiffrer les **statuts** des contacts | **oui** — un bot ne lit jamais de statut |

Sur l'installation mesurée, les seules clés de statut représentaient **2 247
fichiers et 42 % des octets**. Les supprimer a fait tomber la mémoire du
processus de **924 Mo à 438 Mo**.

> **L'ancienneté des fichiers ne veut rien dire.** Le chargement depuis la base
> réécrit tout le dossier au démarrage : les dates de modification sont
> identiques et n'indiquent pas l'âge des données. Triez par **nature**, jamais
> par date.

Procédure d'élagage, dans cet ordre exact (voir Piège 2) :

1. sauvegarder le contenu de la base dans un fichier ;
2. supprimer les fichiers ciblés **sur le disque** ;
3. arrêter proprement (`SIGTERM` déclenche la sauvegarde de ce qui reste) ;
4. redémarrer, puis vérifier que la connexion revient sans QR.

---

## 6. Mémoire : `--max-old-space-size` ne suffit pas

Mesuré : mémoire **anonyme** à 924 Mo alors que le tas V8 était plafonné à
512 Mo. L'écart vient des tampons (`Buffer`) de la session — de la mémoire
**externe** au tas, qu'aucune option V8 ne borne.

Deux conséquences pratiques :

- Sous conteneur, prévoyez un plafond mémoire **largement** au-dessus du tas.
  Node 22 lit la limite du cgroup et dimensionne son tas dessus : relever le
  plafond sans fixer `--max-old-space-size` ne fait que déplacer la cible.
- `docker stats` additionne le **cache de fichiers**, récupérable. Pour juger de
  la pression réelle, lisez `anon` dans le `memory.stat` du cgroup.

---

## 7. Variables d'environnement

| variable | rôle |
|---|---|
| `WHATSAPP_SESSION_PATH` | dossier de session — **pas `/tmp` sur un VPS** |
| `QR_SECRET` | jeton protégeant les routes QR et remise à zéro |
| `ADMIN_EMAIL` | destinataire des alertes de session perdue |

Deux routes à prévoir, **toutes deux protégées par le jeton** :

```
GET  /whatsapp/qr/scan?token=…    affiche le QR courant
POST /whatsapp/reset?token=…      efface la session et force un nouveau QR
```

---

## 8. Tester

N'essayez pas de tester Baileys : cela ouvrirait une vraie session sur un vrai
numéro. **Ne lancez jamais l'application complète depuis un poste de
développement connecté à la configuration de production** — vous ouvririez une
seconde session sur le numéro du client et le déconnecteriez.

Extrayez plutôt les décisions dans des fonctions **pures**, sans dépendance à
Baileys, à la base ni au journal, et testez celles-là :

- `extraireAdressage(key)` — JID classique, `@lid` avec `remoteJidAlt`, `@lid`
  sans, entrée absurde
- `horodatageMs(brut)` — nombre, `bigint`, chaîne, `Long` protobuf, `null`
- `messageTropAncien(...)` — frais, ancien, pile à la borne, horodatage illisible
- votre rapprochement de numéros — format local, international, trop court

C'est la seule partie où les bugs sont silencieux **et** rattrapables par un
test.

---

## Rappel final

Le mode de défaillance dominant de Baileys n'est pas le plantage : c'est le
**succès apparent**. La session se connecte, les messages semblent partir, et
personne ne reçoit rien. Journalisez la forme d'adressage, l'issue de chaque
envoi, et le motif de chaque message écarté. Sans cela, vous n'aurez aucun moyen
de distinguer « le bot n'a rien à envoyer » de « le bot est cassé ».
