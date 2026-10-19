# Déployer sur le VPS mutualisé (socle `/srv/infra`)

Procédure pour la machine décrite dans `vps.md` : Contabo, Ubuntu 24.04, socle
partagé avec PostgreSQL mutualisé, Nginx en frontal et déploiement par CI.

> **Deux procédures existent, ne les mélangez pas.**
> Celle-ci vise le VPS mutualisé, où tout passe par Docker et les scripts
> `/srv/infra`. `deploiement-vps.md` vise une machine nue avec PM2 ou systemd.
> Le réglage `HOST` diffère entre les deux, et s'y tromper rend le service
> injoignable.

**La base reste chez Supabase.** Cloudinary, Resend, Upstash et FedaPay aussi.
Le socle provisionne une base PostgreSQL locale : elle restera vide.

---

## Ce que le dépôt fournit déjà

Le contrat du §5.1 de `vps.md` est rempli :

| Exigence | Où |
|---|---|
| `docker-compose.vps.yml` à la racine | présent |
| Publication sur la boucle locale | `127.0.0.1:${HOST_PORT}:3001` |
| Réseau externe `infra` | déclaré |
| `container_name` distinct | `mtechbenin-api` |
| Plafond mémoire | 1,5 Go |
| Sonde `GET /api/health` | alias de `/health`, même réponse |
| `Dockerfile` autonome | migrations appliquées au démarrage |
| `HOST_PORT` lu dans le `.env` | oui |

---

## 1. Le sous-domaine, en premier

Chez Vercel — le domaine y est délégué (§8 de `vps.md`) — un enregistrement
**A** : `api.mtechbenin.com` → `161.97.158.92`.

> Un enregistrement générique `*` existe et attrape tous les sous-domaines non
> déclarés : `api.` « résoudra » parfaitement **vers la mauvaise machine** tant
> que l'enregistrement explicite n'est pas posé. Ne vous fiez pas au fait que
> le nom résolve.

```bash
getent ahostsv4 api.mtechbenin.com | head -1   # doit donner 161.97.158.92
```

Attendez cette réponse avant l'étape 2 : chaque échec de validation consomme le
quota Let's Encrypt (5 par heure et par domaine).

---

## 2. Provisionner le site

```bash
ssh -i ~/.ssh/bbc_vps root@161.97.158.92

bash deploy/new-site.sh \
  --nom     mtechbenin \
  --domaine api.mtechbenin.com \
  --site    https://mtechbenin.com \
  --repo    git@github.com:TheSanctuaryDev/mtechbenin-backend.git \
  --branche master
```

> **`--branche master`**, pas `main` : ce dépôt utilise `master`. Une erreur ici
> déploierait une branche inexistante.

Le dépôt est privé : ajoutez d'abord la clé publique du serveur comme *deploy
key* en lecture seule sur GitHub.

```bash
cat /home/deploy/.ssh/github_deploy.pub
```

Notez le port attribué :

```bash
cat /srv/infra/ports.txt
```

---

## 3. Le fichier `.env`

`new-site.sh` en génère un calibré pour un autre projet. **Remplacez-le
entièrement** par `.env.vps`, préparé sur le poste du propriétaire.

```bash
# depuis le poste, dans mtechbenin-backend/
scp -i ~/.ssh/bbc_vps .env.vps root@161.97.158.92:/srv/mtechbenin/.env
```

Puis sur le serveur :

```bash
nano /srv/mtechbenin/.env          # renseigner HOST_PORT, laissé vide exprès
chown deploy:deploy /srv/mtechbenin/.env
chmod 600 /srv/mtechbenin/.env
```

`HOST_PORT` est le seul trou : il vient de `ports.txt`. Le deviner ferait
entrer le site en collision avec un voisin.

> Ce fichier contient **tout** — Supabase, FedaPay, les mots de passe IMAP, et
> `AES_SECRET_KEY`. Cette dernière déchiffre les mots de passe des comptes
> streaming : **une valeur différente de celle de Render les rend illisibles,
> définitivement.** Gardez une copie du fichier hors du serveur.

---

## 4. Déployer

```bash
sudo -u deploy /srv/infra/deploy.sh mtechbenin
```

Le script construit l'image, bascule, interroge `/api/health` pendant 90
secondes et **revient à la version précédente** si elle ne répond pas.

```bash
curl -s http://127.0.0.1:<HOST_PORT>/api/health
```

Attendu : `"status":"ok"` et **`"migrations":"ok"`**. Si les migrations ne sont
pas au vert, arrêtez-vous — inutile d'aller plus loin avec un schéma
incomplet. Les journaux :

```bash
cd /srv/mtechbenin && docker compose -f docker-compose.vps.yml --env-file .env logs -f --tail 100
```

---

## 5. TLS

`new-site.sh` pose le vhost et un certificat auto-signé provisoire. Si certbot
n'a pas pu passer (DNS pas encore propagé) :

```bash
certbot --nginx -d api.mtechbenin.com
curl -s https://api.mtechbenin.com/api/health
```

**Fait le 31/08/2026** : certificat Let's Encrypt émis pour
`api.mtechbenin.com`, valable jusqu'au 28/11/2026, renouvellement automatique
programmé par certbot. Le compte ACME de la machine a été réutilisé.

`client_max_body_size` a été porté de 8 Mo à **40 Mo** sur ce vhost. Ce n'est
pas un chiffre de confort : Express concède `UPLOAD_BODY_LIMIT = 35mb` à
`/api/upload` (`src/app.js`). En dessous, Nginx coupe **avant** Express et
renvoie un 413 **en HTML**, que le client d'API ne sait pas lire — l'erreur
paraît muette, au moment précis où l'on ajoute une photo au catalogue. Si vous
changez la limite d'Express, changez celle-ci avec.

---

## 6. Arrêter Render, puis rescanner le QR

**Dans cet ordre, impérativement.** Deux instances sur le même numéro WhatsApp
se déconnectent mutuellement, et liraient les mêmes boîtes IMAP en envoyant
chaque code en double.

1. Suspendre le service Render.
2. Puis, sur le VPS :

```
https://api.mtechbenin.com/api/whatsapp/qr/scan?token=<QR_SECRET>
```

La valeur de `QR_SECRET` se lit dans `/srv/mtechbenin/.env` — elle n'est
volontairement pas reproduite ici, ce document étant versionné.

3. Contrôler `"whatsapp":"connected"` sur `/api/health`.

La session ne se transfère pas : les identifiants Baileys sont liés à
l'appareil. Elle est ensuite persistée dans le volume `whatsapp-session` **et**
dans Supabase, donc un redéploiement ne la perdra plus.

---

## 7. Basculer le frontend

Sur Vercel : `NEXT_PUBLIC_API_URL = https://api.mtechbenin.com`, puis
**redéployer** — les variables `NEXT_PUBLIC_*` sont inscrites dans le bundle à
la construction.

Le site est actuellement **en maintenance** (`src/lib/maintenance.js`,
`FERME_PAR_DEFAUT = true`). Rouvrez-le seulement une fois l'API vérifiée depuis
l'extérieur.

---

## 8. Déploiement continu

**En place depuis le 31/08/2026.** Le workflow est
`.github/workflows/deploiement.yml` ; les trois secrets sont déjà déclarés dans
le dépôt :

| Secret | Valeur |
|---|---|
| `VPS_HOST` | `161.97.158.92` — cette IP, pas un nom d'hôte (voir plus bas) |
| `VPS_USER` | `deploy` |
| `VPS_SSH_KEY` | contenu de `/srv/infra/.ci-mtechbenin` |

Un push sur `master` lance les tests ; s'ils passent, le VPS se met à jour. Les
modifications purement documentaires (`**.md`, `docs/**`) ne déclenchent rien —
inutile de redémarrer le service, donc de rouvrir une session WhatsApp, pour
une phrase corrigée.

Quatre points qui ne se devinent pas :

- **Aucune commande n'est passée au `ssh`**, et ce n'est pas un oubli. La clé
  porte une commande forcée côté serveur
  (`command="/srv/infra/deploy.sh mtechbenin",restrict`). Un
  `ssh … "docker compose up"` serait ignoré **en silence**, et laisserait croire
  que la restriction n'existe pas.
- **L'empreinte de l'hôte est épinglée** dans le workflow. Un `ssh-keyscan` à
  l'exécution, ou `StrictHostKeyChecking=no`, reviendrait à livrer la clé de CI
  à qui répond à cette adresse ce jour-là. C'est pourquoi `VPS_HOST` doit être
  l'IP exacte : un nom d'hôte ne correspondrait pas à l'entrée épinglée.
- **`cancel-in-progress` reste à `false`.** Une annulation pendant la bascule du
  conteneur laisserait le service arrêté, ou à moitié basculé.
- **Un retour arrière fait échouer la CI.** `deploy.sh` sort en erreur si l'API
  ne répond pas après la bascule ; sans cela, un déploiement annulé s'afficherait
  en vert.

Si le serveur est réinstallé, son empreinte change et le workflow échouera à la
connexion : relevez la nouvelle avec `ssh-keyscan -t ed25519 161.97.158.92` et
remplacez-la dans le workflow.

---

## Pièges rencontrés au déploiement réel

Consignés parce qu'aucun ne s'annonce, et que trois d'entre eux réussissent en
apparence.

**Une clé de déploiement GitHub ne sert qu'à UN dépôt.** Celle du serveur
(`github_deploy`) était déjà attachée au site voisin : GitHub refuse la même
clé ailleurs (« key is already in use »). Une paire dédiée a donc été créée,
`~deploy/.ssh/github_mtechbenin`, avec un alias d'hôte dans
`~deploy/.ssh/config`. **Le dépôt doit être cloné via cet alias** :

```
git@github-mtechbenin:TheSanctuaryDev/mtechbenin-backend.git
```

**Compose interpole les valeurs d'`env_file`.** `JWT_SECRET` contient `$vL8` :
Compose y a lu une variable inexistante et l'a remplacée par du vide. La clé
arrivait tronquée dans le conteneur — 50 caractères au lieu de 54 — **sans le
moindre message d'erreur**, puisque signer avec une mauvaise clé fonctionne
très bien ; c'est la vérification qui échoue, ailleurs et plus tard. Dans le
`.env`, tout `$` littéral doit être écrit `$$`.

Contrôle, à refaire après toute modification du `.env` :

```bash
docker exec mtechbenin-api sh -lc 'printf %s "$JWT_SECRET" | wc -c'   # 54
docker exec mtechbenin-api sh -lc 'printf %s "$AES_SECRET_KEY" | wc -c'  # 34
```

**`new-site.sh` lance son premier déploiement en tant que root**, dans un dépôt
appartenant à `deploy` : git refuse (« dubious ownership »). Sans conséquence —
relancez simplement `sudo -u deploy /srv/infra/deploy.sh <nom>`, qui est la
forme documentée.

**Relever le plafond mémoire ne réduit pas le pic.** Node 22 lit la limite du
cgroup et dimensionne son tas dessus : à 768 Mo le démarrage culminait à 708 Mo
(92 %), à 1 Go à 942 Mo (92 %). Il ne débordait pas, il différait ses collectes.
C'est `--max-old-space-size` qui borne réellement — avec 512 Mo, le pic est
retombé à 74 % et le repos à 10 %.

**Mais cette borne ne couvre pas tout.** Mesuré ensuite en production : la
mémoire **anonyme** atteignait 924 Mo alors que le tas était plafonné à 512 Mo.
L'écart tient aux tampons (`Buffer`) de la session Baileys — mémoire *externe*
au tas, qu'aucun `--max-old-space-size` ne borne. La session compte **25 884
fichiers**, tous chargés en mémoire et re-sérialisés en un seul JSON à chaque
sauvegarde. Le plafond du conteneur est donc passé à 1,5 Go (47 % à l'usage),
mais le vrai correctif est en amont : cette session n'a aucune raison d'être si
grosse.

Corollaire de méthode : `docker stats` additionne le cache de fichiers, qui est
récupérable et ne menace rien. Pour savoir si un conteneur est réellement près
de sa limite, lisez `anon` dans le `memory.stat` de son cgroup — pas le total.

---

## À vérifier avant de vous engager

Le pare-feu n'ouvre que 22, 80 et 443 **en entrée**. Ce backend a besoin de
**sortir** vers :

| Destination | Port |
|---|---|
| Supabase (pooler / direct) | 6543 / 5432 |
| Gmail IMAP | 993 |
| Cloudinary, Resend, Upstash, FedaPay, WhatsApp | 443 |

`ufw` autorise la sortie par défaut, donc c'est probablement déjà bon. À
confirmer d'une commande :

```bash
ufw status verbose | head -5      # chercher : Default: ... allow (outgoing)
```

Si la sortie est restreinte, la base serait injoignable et le bot IMAP muet —
deux pannes peu bavardes.

---

## Ce que cette machine ne fait pas

- **Aucune supervision.** Un conteneur mort est relancé, mais personne n'est
  prévenu. Vos alertes e-mail deviennent le seul dispositif d'alerte : ne les
  désactivez pas.
- **Pas de swap.** D'où le plafond mémoire, et la nécessité de le surveiller :
  `docker stats mtechbenin-api --no-stream`. Attention, ce chiffre inclut le
  cache de fichiers, récupérable ; pour la mémoire réellement occupée, lisez la
  ligne `anon` du `memory.stat` du cgroup.
- **Une seule instance, et ce n'est pas négociable.** Ce processus tient aussi
  la session WhatsApp et les bots IMAP. Deux répliques ouvriraient deux
  sessions sur le même numéro et liraient les mêmes boîtes en double.
- **Les sauvegardes du socle ne vous couvrent pas** : vos données sont chez
  Supabase, qui fait les siennes.

---

## Retour à Render

1. Réactiver le service Render.
2. `NEXT_PUBLIC_API_URL` sur l'URL Render, redéployer le front.
3. `cd /srv/mtechbenin && docker compose -f docker-compose.vps.yml --env-file .env down`
4. Rescanner le QR côté Render — la session ne suit pas.

Rien à défaire dans le code : les valeurs par défaut restent celles de Render.
