#!/usr/bin/env bash
#
# Mise à jour du backend sur le VPS.
#
#   cd /srv/mtechbenin/backend && ./deploy/deployer.sh
#
# Ne sert QUE sur le VPS. Render déploie tout seul depuis GitHub.

set -euo pipefail

# `set -e` seul ne suffit pas : sans `pipefail`, une commande qui échoue au
# milieu d'un tube laisse le script continuer comme si de rien n'était.

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RACINE"

echo "▸ Dossier : $RACINE"

# ── Garde-fou : un travail non commité serait écrasé par le pull ─────────────
# Sur un serveur, une modification locale est presque toujours un correctif
# posé en urgence et jamais remonté. L'écraser sans prévenir le ferait
# disparaître sans trace.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "✖ Des modifications non commitées existent ici." >&2
  echo "  Elles seraient perdues. Committez-les ou annulez-les d'abord :" >&2
  git status --short >&2
  exit 1
fi

BRANCHE="$(git rev-parse --abbrev-ref HEAD)"
AVANT="$(git rev-parse --short HEAD)"
echo "▸ Branche $BRANCHE, actuellement sur $AVANT"

echo "▸ Récupération…"
git pull --ff-only origin "$BRANCHE"

APRES="$(git rev-parse --short HEAD)"
if [ "$AVANT" = "$APRES" ]; then
  echo "▸ Déjà à jour ($APRES). Rien à faire."
  exit 0
fi
echo "▸ $AVANT → $APRES"

# `npm ci` et non `npm install` : il installe EXACTEMENT ce que décrit
# package-lock.json et échoue si les deux fichiers divergent. `install` peut
# monter une version mineure en silence — sur un serveur de production, une
# dépendance qui change toute seule est une panne qu'on ne saura pas expliquer.
echo "▸ Dépendances…"
npm ci --omit=dev

echo "▸ Client Prisma et migrations…"
npm run deploy:prepare

# ── Redémarrage ──────────────────────────────────────────────────────────────
# `reload` plutôt que `restart` : PM2 attend l'arrêt propre du processus, qui
# sauvegarde la session WhatsApp avant de rendre la main.
if command -v pm2 >/dev/null 2>&1 && pm2 describe mtechbenin-backend >/dev/null 2>&1; then
  echo "▸ Redémarrage (PM2)…"
  pm2 reload ecosystem.config.js --update-env
elif systemctl list-units --full -all 2>/dev/null | grep -q "mtechbenin-backend.service"; then
  echo "▸ Redémarrage (systemd)…"
  sudo systemctl restart mtechbenin-backend
else
  echo "✖ Ni PM2 ni systemd ne connaissent ce service — redémarrez à la main." >&2
  exit 1
fi

# ── Vérification ─────────────────────────────────────────────────────────────
# Un déploiement n'est fini que si le service répond. Sans ce contrôle, un
# démarrage qui échoue passerait pour un succès.
PORT_LOCAL="${PORT:-3001}"
echo "▸ Vérification de /health…"
for i in $(seq 1 30); do
  if REPONSE="$(curl -fsS -m 5 "http://127.0.0.1:${PORT_LOCAL}/health" 2>/dev/null)"; then
    echo "✔ En ligne : $REPONSE"
    case "$REPONSE" in
      *'"migrations":"ok"'*) ;;
      *) echo "⚠ Les migrations ne sont PAS au vert — vérifiez les journaux." >&2 ;;
    esac
    exit 0
  fi
  sleep 2
done

echo "✖ Aucune réponse de /health après 60 s. Journaux :" >&2
if command -v pm2 >/dev/null 2>&1; then
  pm2 logs mtechbenin-backend --lines 40 --nostream >&2 || true
else
  sudo journalctl -u mtechbenin-backend -n 40 --no-pager >&2 || true
fi
exit 1
