# Guide du serveur MTECHBENIN — consulter le site depuis un Mac

Ce guide s'adresse à quelqu'un qui n'est pas développeur. Il explique comment
se connecter au serveur qui fait tourner le site MTECHBENIN, et comment
vérifier que tout va bien.

**Votre accès est en lecture seule.** Vous pouvez regarder l'état du site, lire
son journal et parcourir son code. Vous ne pouvez rien modifier, rien
supprimer, ni redémarrer quoi que ce soit : vous ne risquez donc pas de casser
le site en essayant une commande. Si une commande vous répond « Permission
denied » (permission refusée), c'est normal — elle sort de votre accès.

---

## 1. Ouvrir le Terminal

Le Terminal est l'application du Mac qui permet de taper des commandes.

1. Appuyez sur **⌘ Cmd + Espace** pour ouvrir la recherche.
2. Tapez **Terminal**, puis **Entrée**.

Une fenêtre s'ouvre avec une ligne qui se termine par `%` ou `$` : c'est là
qu'on tape les commandes. Pour lancer une commande, tapez-la (ou
collez-la avec **⌘ Cmd + V**), puis appuyez sur **Entrée**.

---

## 2. Créer votre clé de connexion (une seule fois)

Le serveur ne demande pas de mot de passe : il reconnaît votre Mac grâce à une
**clé**, faite de deux parties.

- La **clé privée** reste sur votre Mac. Ne la donnez jamais à personne, ne
  l'envoyez jamais par message ou par e-mail.
- La **clé publique** peut être partagée sans risque : c'est elle que vous
  envoyez à votre prestataire pour qu'il ouvre votre accès.

Dans le Terminal, tapez :

```bash
ssh-keygen -t ed25519 -C "client-mtechbenin"
```

Appuyez sur **Entrée** à chaque question (trois fois). Ensuite, affichez votre
clé publique :

```bash
cat ~/.ssh/id_ed25519.pub
```

Une ligne s'affiche, qui commence par `ssh-ed25519`. **Copiez cette ligne
entière** et envoyez-la à votre prestataire. Votre accès sera ouvert une fois
qu'il l'aura ajoutée au serveur.

---

## 3. Créer un raccourci de connexion (une seule fois)

Pour ne pas retaper l'adresse du serveur à chaque fois, créez un raccourci.
Copiez ce bloc en entier dans le Terminal, puis **Entrée** :

```bash
mkdir -p ~/.ssh && cat >> ~/.ssh/config <<'EOF'

Host mtechbenin
    HostName api.mtechbenin.com
    User mtechbenin-lecture
    IdentityFile ~/.ssh/id_ed25519
EOF
chmod 600 ~/.ssh/config
```

---

## 4. Se connecter au serveur

```bash
ssh mtechbenin
```

**La toute première fois**, le Mac affiche un message qui commence par
« The authenticity of host … can't be established ». C'est normal : tapez
**yes**, puis **Entrée**. Ce message n'apparaîtra plus ensuite.

Vous êtes connecté quand la ligne de commande se termine par
`mtechbenin-lecture@…:~$`. Toutes les commandes des sections suivantes se
tapent **à partir de là**.

Pour vous **déconnecter** :

```bash
exit
```

---

## 5. Vérifier que le site va bien

Ces cinq commandes sont faites pour vous. Elles ne modifient rien.

| Commande | Ce qu'elle fait |
|---|---|
| `site-sante` | Demande au site s'il va bien. La réponse doit contenir `"status":"ok"` et `"whatsapp":"connected"`. |
| `site-etat` | Montre si le site tourne. Dans la colonne STATUS, `Up … (healthy)` veut dire : il tourne et il va bien. |
| `site-journal` | Affiche les 100 derniers événements du site (commandes, envois de codes, erreurs). |
| `site-journal-long` | Pareil, sur les 500 derniers événements. |
| `site-ressources` | Montre la mémoire et le processeur utilisés par le site. |

### Comment lire les réponses

**`site-sante`**

```
{"status":"ok","env":"production","whatsapp":"connected","migrations":"ok",...}
```

- `"status":"ok"` : le site répond normalement.
- `"whatsapp":"connected"` : l'envoi des messages WhatsApp fonctionne.
  Si vous lisez autre chose (par exemple `disconnected`), prévenez votre
  prestataire : les clients ne reçoivent plus leurs messages.
- Si la commande ne répond rien du tout, le site est arrêté : prévenez votre
  prestataire.

**`site-etat`**

- `Up 3 hours (healthy)` : le site tourne depuis 3 heures et va bien.
- `(unhealthy)` ou `Restarting` : le site a un problème — prévenez votre
  prestataire.
- Aucune ligne sous les titres : le site est arrêté — prévenez votre
  prestataire.

**`site-journal`**

Chaque ligne est un événement. Repérez surtout le mot `"level":"error"` : ce
sont les erreurs. Une erreur isolée est souvent sans conséquence ; beaucoup
d'erreurs à la suite méritent un message à votre prestataire, avec une copie de
ces lignes.

---

## 6. Parcourir le code du site (lecture seule)

Le code du site se trouve dans le dossier `/srv/mtechbenin`.

| Commande | Ce qu'elle fait |
|---|---|
| `cd /srv/mtechbenin` | Aller dans le dossier du site. |
| `ls` | Lister ce que contient le dossier où vous êtes. |
| `ls -la` | Pareil, avec les détails (taille, date de modification). |
| `cd src` | Entrer dans un sous-dossier (ici `src`). |
| `cd ..` | Remonter d'un dossier. |
| `pwd` | Afficher le dossier où vous êtes. |
| `cat package.json` | Afficher le contenu d'un fichier court. |
| `less src/app.js` | Lire un fichier long page par page : **Espace** pour avancer, **q** pour quitter. |
| `grep -rn "Netflix" src` | Chercher un mot dans tous les fichiers du dossier `src`. |
| `clear` | Effacer l'écran du Terminal. |

Le fichier `.env` (les mots de passe et clés secrètes du site) vous est
volontairement fermé : c'est normal si `cat .env` répond « Permission denied ».

---

## 7. Astuces

- **Flèche du haut** : rappelle la commande précédente, pour ne pas la retaper.
- **Tab** : complète automatiquement un nom de dossier ou de fichier.
- **Ctrl + C** : arrête une commande qui ne se termine pas, ou qui affiche trop
  de choses.
- Pour **copier** du texte affiché dans le Terminal : sélectionnez-le à la
  souris, puis **⌘ Cmd + C**.

---

## 8. En cas de problème

| Ce que vous voyez | Ce que ça veut dire | Que faire |
|---|---|---|
| `Permission denied (publickey)` en vous connectant | Votre clé n'est pas encore (ou plus) autorisée sur le serveur. | Renvoyez votre clé publique (section 2) à votre prestataire. |
| `Could not resolve hostname` | Pas de connexion internet, ou faute de frappe. | Vérifiez votre connexion, et tapez bien `ssh mtechbenin`. |
| `Connection timed out` | Le serveur ne répond pas. | Réessayez dans quelques minutes ; si ça persiste, prévenez votre prestataire. |
| `Permission denied` sur une commande, une fois connecté | La commande sort de votre accès en lecture seule. | Normal : rien n'a été modifié. |

Quand vous écrivez à votre prestataire au sujet d'un problème, joignez la
réponse de `site-sante` et de `site-etat` : cela lui fait gagner beaucoup de
temps.
