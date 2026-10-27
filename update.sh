#!/usr/bin/env bash
# Mise à jour automatique : lancé par cron chaque minute. Va chercher GitHub ; s'il y a du nouveau,
# applique. La page (app/index.html) est relue à chaque requête ; le serveur ou le compose changent → redémarrage.
set -u
cd /opt/zakroll || exit 0
git fetch -q origin main 2>/dev/null || exit 0
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0
CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE")
git reset -q --hard origin/main
echo "$(date -Is) mise à jour $LOCAL -> $REMOTE"
echo "$CHANGED" | sed 's/^/  /'
if echo "$CHANGED" | grep -qE '^(server\.js|shim\.js|drive\.js|docker-compose\.yml)$'; then
  docker compose up -d --force-recreate >/dev/null 2>&1 && echo "  serveur redémarré"
fi
