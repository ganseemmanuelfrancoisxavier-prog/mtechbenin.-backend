# Bot OTP — configuration des boîtes mail

Le bot surveille les boîtes des comptes streaming et transmet les codes de
vérification aux clients qui ont payé l'abonnement correspondant.

## Boîtes à configurer

Ce sont les adresses des comptes streaming enregistrés dans l'admin :

| Boîte | Sert à |
|---|---|
| `mtechbenin7@gmail.com` | Comptes Netflix (profils PARIS, LONDRE, NEW YORK, CHICAGO) |
| `mtechbenin0@gmail.com` | Comptes Netflix (profils CALIFONIA, LOS ANGELES, TOKYO) |
| `mtechbenin@outlook.com` | Compte Netflix (profil ABIDJAN) |
| `emelianoswilliams@gmail.com` | **Boîte de test** — aucun envoi client (voir ci-dessous) |

> Toute nouvelle adresse ajoutée à un compte dans l'admin doit aussi être ajoutée
> ici, sinon ses codes ne seront jamais reçus. Le bot le signale au démarrage :
> `⚠️ N adresse(s) de compte famille ne sont surveillées par aucune boîte IMAP`.

## Obtenir un mot de passe d'application

Gmail et Outlook refusent le mot de passe habituel du compte pour IMAP. Il faut
générer un **mot de passe d'application** dédié.

**Gmail** — la validation en 2 étapes doit être activée sur le compte :
1. https://myaccount.google.com/apppasswords
2. Nommer l'application (ex. « Bot MTECHBENIN ») → Créer
3. Copier les 16 caractères affichés (format `xxxx xxxx xxxx xxxx`, espaces inclus)

**Outlook / Hotmail** — la vérification en 2 étapes doit être activée :
1. https://account.microsoft.com/security → Options de sécurité avancées
2. Mots de passe d'application → Créer
3. Copier le mot de passe généré

Vérifier aussi que **IMAP est activé** : Gmail → Paramètres → Transfert et
POP/IMAP → Activer IMAP.

## Renseigner la configuration

La valeur est un tableau JSON **sur une seule ligne**. Attention : elle ne
s'écrit pas de la même façon selon l'endroit.

**Sur Render** (Environment → Add Environment Variable), coller la valeur
**nue**, sans rien autour. C'est la forme à utiliser :

```
[{"user":"mtechbenin7@gmail.com","pass":"abcd efgh ijkl mnop"},{"user":"mtechbenin0@gmail.com","pass":"..."},{"user":"mtechbenin@outlook.com","pass":"..."}]
```

**Dans le fichier `.env` local**, entourer d'apostrophes simples — sinon le
`#` d'un mot de passe couperait la ligne :

```
IMAP_ACCOUNTS='[{"user":"mtechbenin7@gmail.com","pass":"abcd efgh ijkl mnop"}]'
```

Ces apostrophes appartiennent à la syntaxe du fichier `.env`, pas à la valeur.
Les recopier dans l'interface de Render en ferait partie et le JSON deviendrait
illisible. Le bot les retire désormais si elles s'y trouvent, mais autant ne pas
les mettre.

`host` et `port` sont facultatifs : ils sont déduits du domaine.

Une entrée sans mot de passe est ignorée avec un avertissement au démarrage —
les autres boîtes continuent de fonctionner. On peut donc déployer
progressivement, boîte par boîte.

## Boîte de test (aucun envoi client)

Une boîte peut être surveillée **sans jamais écrire à un client** : le bot
calcule le destinataire qui aurait reçu le code et envoie ce diagnostic à
l'admin sur WhatsApp. Rien n'est enregistré en base, donc aucun quota d'OTP
n'est consommé.

C'est indispensable pour tester sans risque : les services sans compte famille
(Spotify, Apple Music…) se résolvent **par service**, sans lien avec la boîte
d'origine — un simple mail de test partirait donc à un vrai client.

Deux façons de l'activer :

```bash
# Pour la boîte historique (IMAP_EMAIL)
IMAP_TEST_ONLY=true

# Pour une entrée de IMAP_ACCOUNTS
{"user":"test@gmail.com","pass":"...","testOnly":true}
```

Au démarrage, ces boîtes apparaissent avec le suffixe `(TEST)` dans les logs.

## Vérifier que ça marche

Au démarrage, les logs doivent afficher :

```
📬 BOT IMAP démarré — 4 boîte(s) surveillée(s) : ...
✅ [mtechbenin7@gmail.com] IMAP connecté — surveillance active
🔗 Réconciliation commandes : N abonnement(s) reconstruit(s), ...
```

Si une adresse de compte n'est surveillée par aucune boîte, un avertissement
explicite la nomme.

## Règles appliquées

- Seules les commandes **payées et non expirées** peuvent recevoir un code.
- Sur une boîte partagée par plusieurs clients, le code va au **dernier acheteur
  actif** de ce compte.
- **Un seul code par commande, à vie.** Toute tentative supplémentaire est
  bloquée et signalée à l'admin sur WhatsApp, avec le code et la liste des
  clients actifs, pour un transfert manuel.
- Si la boîte n'est rattachée à aucun compte connu pour un service famille, le
  bot refuse de deviner et alerte l'admin plutôt que de risquer d'envoyer le code
  au mauvais client.
