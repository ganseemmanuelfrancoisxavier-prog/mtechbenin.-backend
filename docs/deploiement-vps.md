# Déployer le backend sur un VPS Ubuntu (machine nue)

> **Deux procédures existent.** Celle-ci vise une machine **nue**, que vous
> installez vous-même avec PM2 ou systemd.
>
> Pour le VPS mutualisé déjà en service (Contabo, socle `/srv/infra`, Docker et
> Nginx partagés), suivez **`deploiement-vps-mutualise.md`** : c'est la
> procédure réelle.
>
> Le réglage `HOST` diffère entre les deux — `127.0.0.1` ici, `0.0.0.0` sur le
> socle mutualisé, où c'est le mappage de port Docker qui restreint l'accès.
> S'y tromper rend le service injoignable, sans message d'erreur explicite.

Procédure à suivre **une fois le VPS acheté**. Rien ici n'est nécessaire tant
que le backend tourne sur Render : les deux hébergements restent possibles, le
même code fonctionne sur l'un comme sur l'autre.

Le frontend ne bouge pas — il reste sur Vercel. Une seule variable y changera,
à la toute fin.

---

## 0. Ce que vous devez avoir sous la main

- Un VPS **Ubuntu 22.04 ou 24.04**, accès `root` ou un utilisateur `sudo`.
- Un **sous-domaine** pointant vers son IP, par exemple `api.mtechbenin.com`.
- Le contenu de vos variables d'environnement Render (onglet *Environment*).
- 1 Go de RAM suffit ; 2 Go sont plus confortables — Baileys garde ses clés de
  session en mémoire.

**Avant tout : notez la valeur actuelle de `NEXT_PUBLIC_API_URL` sur Vercel.**
C'est votre chemin de retour si la bascule tourne mal.

---

## 1. Le domaine, en premier

Chez votre registrar, un enregistrement **A** :

```
api    A    <IP de votre VPS>
```

Faites-le maintenant : la propagation DNS prend de quelques minutes à quelques
heures, et **certbot refusera d'émettre un certificat tant qu'elle n'est pas
faite**. Autant qu'elle travaille pendant que vous installez le reste.

Vérification :

```bash
dig +short api.mtechbenin.com
```

Tant que cette commande ne renvoie pas l'IP de votre VPS, ne lancez pas
l'étape 6.

---

## 2. Préparer la machine

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx ufw

# Node 22 — la version que le projet déclare dans `engines`.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v    # doit afficher v22.x
```

### Pare-feu

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

> **Le port 3001 n'est jamais ouvert.** nginx parle au backend en local. Ouvrir
> 3001 laisserait joindre l'API en clair, sans HTTPS, sans les protections de
> nginx — et rendrait toute cette installation inutile.

### Un utilisateur dédié

```bash
sudo adduser --system --group --home /srv/mtechbenin mtechbenin
sudo mkdir -p /srv/mtechbenin/backend /var/lib/mtechbenin /var/log/mtechbenin
sudo chown -R mtechbenin:mtechbenin /srv/mtechbenin /var/lib/mtechbenin /var/log/mtechbenin
```

`/var/lib/mtechbenin` accueillera la **session WhatsApp**. Elle doit vivre hors
de `/tmp`, que `systemd-tmpfiles` purge périodiquement — y compris pendant que
le service tourne.

---

## 3. Le code

```bash
sudo -u mtechbenin -H bash
cd /srv/mtechbenin
git clone https://github.com/TheSanctuaryDev/mtechbenin-backend.git backend
cd backend
npm ci --omit=dev
```

---

## 4. Les variables d'environnement

```bash
cp .env.example .env
nano .env
```

Reprenez **toutes** les valeurs depuis Render, puis réglez ces quatre-là,
propres au VPS :

| Variable | Valeur sur le VPS | Pourquoi |
|---|---|---|
| `HOST` | `127.0.0.1` | referme le port 3001 sur la machine |
| `WHATSAPP_SESSION_PATH` | `/var/lib/mtechbenin/whatsapp-session` | dossier persistant, hors `/tmp` |
| `CORS_ORIGINS` | `https://mtechbenin.com,https://www.mtechbenin.com` | autorise vos domaines de front |
| `DIRECT_URL` | URL Supabase **port 5432**, sans `?pgbouncer=true` | les migrations ne passent pas par le pooler |
| `NODE_ENV` | `production` | |

```bash
chmod 600 .env
```

> `DIRECT_URL` manque aujourd'hui dans la configuration Render. Sans elle,
> `prisma migrate deploy` échoue au démarrage sur une machine neuve. Récupérez-la
> dans Supabase → *Project Settings* → *Database* → *Connection string* → *Direct*.

Migrations et client Prisma :

```bash
npm run deploy:prepare
```

---

## 5. Lancer le service

Deux options. **Choisissez-en une seule** — les deux relanceraient le même
processus et se disputeraient le port 3001.

### Option A — PM2 (recommandée)

```bash
sudo npm install -g pm2
cd /srv/mtechbenin/backend
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u mtechbenin --hp /srv/mtechbenin
# exécutez la commande que pm2 affiche, avec sudo
```

### Option B — systemd

```bash
exit                      # revenir à votre compte sudo
sudo cp /srv/mtechbenin/backend/deploy/mtechbenin-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mtechbenin-backend
sudo systemctl status mtechbenin-backend
```

### Vérifier

```bash
curl -s http://127.0.0.1:3001/health
```

Attendu : `"status":"ok"` et **`"migrations":"ok"`**. Si les migrations ne sont
pas au vert, arrêtez-vous là et lisez les journaux — inutile d'aller plus loin
avec un schéma incomplet.

```bash
pm2 logs mtechbenin-backend --lines 50      # option A
sudo journalctl -u mtechbenin-backend -n 50 # option B
```

---

## 6. nginx et HTTPS

```bash
sudo cp /srv/mtechbenin/backend/deploy/nginx.conf.example \
        /etc/nginx/sites-available/mtechbenin-backend
sudo nano /etc/nginx/sites-available/mtechbenin-backend   # remplacez le server_name
sudo ln -s /etc/nginx/sites-available/mtechbenin-backend /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Certificat :

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.mtechbenin.com
```

certbot ajoute lui-même le bloc TLS et la redirection HTTP → HTTPS, et
programme le renouvellement. C'est pourquoi le fichier fourni est en clair : y
référencer des certificats inexistants empêcherait nginx de démarrer.

```bash
curl -s https://api.mtechbenin.com/health
sudo certbot renew --dry-run
```

---

## 7. La session WhatsApp

Elle **ne se transfère pas** depuis Render : les identifiants Baileys sont liés
à l'appareil. Après la bascule, il faut rescanner **une fois**.

```
https://api.mtechbenin.com/api/whatsapp/qr/scan?token=<QR_SECRET>
```

Scannez depuis le téléphone de la boutique. Contrôlez ensuite que `/health`
affiche `"whatsapp":"connected"`.

> Ne laissez pas Render et le VPS tourner **en même temps** avec la même
> session : deux connexions sur le même numéro se déconnectent mutuellement, et
> les deux instances liraient la même boîte IMAP en envoyant chaque code en
> double. Arrêtez le service Render **avant** de scanner sur le VPS.

---

## 8. Basculer le frontend

Sur Vercel → *Settings* → *Environment Variables* :

```
NEXT_PUBLIC_API_URL = https://api.mtechbenin.com
```

Puis **redéployez** : les variables `NEXT_PUBLIC_*` sont inscrites dans le
bundle à la construction, un simple changement de valeur ne suffit pas.

Vérifiez enfin que `CORS_ORIGINS` sur le VPS contient bien le domaine exact du
front, **sans barre finale**. Une origine absente donne une erreur CORS dans le
navigateur alors que l'API répond parfaitement en `curl` — symptôme classique
et déroutant.

---

## 9. Mises à jour

```bash
sudo -u mtechbenin -H bash
cd /srv/mtechbenin/backend
./deploy/deployer.sh
```

Le script refuse de tourner s'il trouve des modifications non commitées — sur
un serveur, c'est presque toujours un correctif posé en urgence, et l'écraser
le ferait disparaître sans trace. Il récupère, installe avec `npm ci`, applique
les migrations, redémarre, puis **vérifie `/health`** : un déploiement n'est
terminé que si le service répond.

---

## 10. Revenir à Render

Rien à défaire dans le code : les valeurs par défaut sont celles de Render.

1. Redémarrez le service Render.
2. Remettez `NEXT_PUBLIC_API_URL` sur l'URL Render, redéployez le front.
3. Arrêtez le service du VPS (`pm2 stop mtechbenin-backend` ou
   `sudo systemctl stop mtechbenin-backend`).
4. Rescannez le QR WhatsApp côté Render — la session ne suit pas.

---

## Ce qu'il faut savoir avant de dimensionner

**Le backend est un processus unique, et il doit le rester.** Il sert l'API,
tient la session WhatsApp et lit les boîtes IMAP. Lancer plusieurs instances —
PM2 en mode `cluster`, plusieurs conteneurs, deux serveurs — ouvrirait
plusieurs sessions WhatsApp sur le même numéro, qui se déconnecteraient
mutuellement, et ferait lire la même boîte en double avec chaque code envoyé
deux fois.

`ecosystem.config.js` fixe donc `instances: 1` et `exec_mode: "fork"`.
**Ne le changez pas** sans avoir d'abord sorti les deux bots dans un processus
séparé.

---

## Sauvegardes

La base est chez Supabase, qui en assure les siennes. Deux choses ne vivent que
sur le VPS :

- **`/srv/mtechbenin/backend/.env`** — tous vos secrets. Perdu, il faut tout
  regénérer. Gardez-en une copie hors du serveur.
- **`/var/lib/mtechbenin/whatsapp-session`** — la session. Perdue, un QR à
  rescanner : ennuyeux, pas dramatique.

`AES_SECRET_KEY` mérite une attention particulière : elle chiffre les mots de
passe des comptes streaming. **La perdre rend tous ces mots de passe
illisibles, définitivement** — ils devront être ressaisis un par un dans le
panel.
