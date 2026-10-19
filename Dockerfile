# Image du backend MTECHBENIN — TROISIÈME voie, optionnelle.
#
# PM2 ou systemd suffisent sur un VPS simple. Docker n'a d'intérêt ici que si
# vous voulez isoler le backend d'autres services sur la même machine, ou
# reproduire l'environnement à l'identique ailleurs.
#
# Construction lancée depuis mtechbenin-backend/ :
#   docker build -t mtechbenin-backend .
#   docker run -d --name backend -p 127.0.0.1:3001:3001 \
#     --env-file .env \
#     -v /var/lib/mtechbenin/whatsapp-session:/data/whatsapp-session \
#     -e WHATSAPP_SESSION_PATH=/data/whatsapp-session \
#     --restart unless-stopped mtechbenin-backend

FROM node:22-slim AS base

# openssl : Prisma en a besoin pour détecter la cible et se connecter en TLS.
# Absent de l'image slim, son manque produit une erreur de moteur Prisma au
# démarrage, difficile à relier à sa cause.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Dépendances ──────────────────────────────────────────────────────────────
# Copiées seules d'abord : Docker réutilise cette couche tant que les deux
# fichiers ne changent pas. Copier tout le code d'abord réinstallerait tout à
# chaque modification d'une ligne de source.
COPY package*.json ./
RUN npm ci --omit=dev

# Le schéma avant le reste : le client Prisma se génère à la construction, pas
# au démarrage. Le générer au boot ajouterait plusieurs secondes à chaque
# redémarrage du conteneur.
COPY prisma ./prisma
RUN npx prisma generate

COPY . .

# ── Utilisateur non privilégié ───────────────────────────────────────────────
# `node` existe déjà dans l'image officielle. Le dossier de session doit lui
# appartenir, sinon Baileys ne peut rien y écrire.
# Les dossiers montes comme volumes doivent EXISTER dans l'image, et
# appartenir a `node`.
#
# Docker, en montant un volume nomme, copie le contenu ET la propriete du
# chemin present dans l'image. Si le chemin n'existe pas, il cree le point de
# montage en `root:root` — et le conteneur, qui tourne en `node`, ne peut plus
# y ecrire. Constate en production : le journal persistant s'annonçait au
# demarrage puis n'ecrivait rien, winston n'echouant pas bruyamment sur un
# transport fichier inaccessible.
RUN mkdir -p /data/whatsapp-session /data/journaux && chown -R node:node /data /app
USER node

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV WHATSAPP_SESSION_PATH=/data/whatsapp-session

EXPOSE 3001

# La sonde interroge le service lui-même : un conteneur qui tourne sans
# répondre n'est pas en bonne santé.
# Meme chemin que la sonde du socle VPS (`/api/health`) : deux chemins
# differents finiraient par diverger, et l'un des deux mentirait.
# 90 s de grace : le demarrage applique les migrations Prisma et restaure la
# session WhatsApp depuis Supabase.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3001/api/health || exit 1

# Les migrations ne sont PAS jouées ici : plusieurs conteneurs démarrant
# ensemble les joueraient en parallèle sur la même base. `src/app.js` les
# applique déjà au démarrage, avec son propre garde-fou.
CMD ["node", "src/app.js"]
