# Zak Roll

Suivi de tournage des scripts vidéo de l'équipe Zak. Une page, un petit serveur Node sans dépendance, un fichier JSON pour les données.

- `app/index.html` : la page (les courtiers lisent, cochent et déposent ; l'admin édite tout en place).
- `shim.js` : le pont entre la page et l'API (`db`, `user`, `downloads`).
- `server.js` : l'API, les liens, le flux temps réel.
- `docker-compose.yml` : conteneur `node:20-alpine` derrière Traefik.
- `install.sh` : installation en une commande sur le VPS (détecte Traefik, génère le jeton admin, installe la mise à jour automatique).
- `update.sh` : lancé par cron chaque minute ; applique ce qui est poussé sur `main`.

Liens : `https://DOMAIN/equipe` pour les courtiers, `https://DOMAIN/admin-<jeton>` pour l'admin. Le jeton est dans `/opt/zakroll/.env` sur le serveur ; les données dans `/opt/zakroll/data/db.json`. Rien de tout ça n'est dans ce dépôt.
