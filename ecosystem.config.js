// Configuration PM2 — déploiement sur VPS Ubuntu.
//
// Ce fichier ne sert QUE sur le VPS. Render ignore PM2 et lance `npm start` :
// rien ici ne l'affecte.
module.exports = {
  apps: [
    {
      name: "mtechbenin-backend",
      script: "src/app.js",

      // ── UNE SEULE INSTANCE. Ce n'est pas un réglage de confort. ───────────
      //
      // Ce processus ne fait pas qu'servir l'API : il tient AUSSI la session
      // WhatsApp (Baileys) et le bot IMAP. En mode `cluster`, chaque instance
      // ouvrirait sa propre session WhatsApp sur le même numéro — elles se
      // déconnecteraient mutuellement — et lirait la même boîte mail, envoyant
      // chaque code de vérification en double.
      //
      // Monter en charge demanderait d'abord de sortir ces deux bots dans un
      // processus séparé. Tant que ce n'est pas fait : `fork`, une instance.
      instances: 1,
      exec_mode: "fork",

      // Redémarrage automatique, avec un frein.
      //
      // `min_uptime` + `max_restarts` : si le processus meurt moins de 10 s
      // après son démarrage, 10 fois de suite, PM2 abandonne au lieu de
      // boucler. Une base injoignable ou une variable manquante produit
      // exactement ce profil — mieux vaut un service arrêté et visible qu'un
      // redémarrage perpétuel qui masque la panne.
      autorestart: true,
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 4000,

      // Redémarre si le processus dépasse ce seuil. Baileys garde en mémoire
      // les clés de session, et une fuite lente finirait par saturer un petit
      // VPS. À ajuster selon la RAM réellement disponible.
      max_memory_restart: "500M",

      env: {
        NODE_ENV: "production",
      },

      // Les variables sensibles viennent de `.env`, jamais d'ici : ce fichier
      // est versionné.
      //
      // PM2 ne lit pas `.env` tout seul — `src/app.js` le fait via `dotenv`.

      // Journaux horodatés, sortie et erreurs séparées.
      time: true,
      out_file: "/var/log/mtechbenin/backend-out.log",
      error_file: "/var/log/mtechbenin/backend-error.log",
      merge_logs: true,

      // Laisse à l'arrêt propre le temps de sauvegarder la session WhatsApp
      // (`shutdown()` dans src/app.js, sur SIGTERM). PM2 attend ce délai avant
      // de tuer le processus ; trop court, une rotation de clé Baileys serait
      // perdue et la session invalidée au redémarrage.
      kill_timeout: 10000,

      // N'écoute aucun changement de fichier : les mises à jour passent par
      // `deploy/deployer.sh`, jamais par une écriture sauvage sur le serveur.
      watch: false,
    },
  ],
};
