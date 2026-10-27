#!/usr/bin/env bash
# Installation de Zak Roll sur un VPS Ubuntu avec Docker + Traefik déjà en place.
# Usage (en root) :  DOMAIN=zakroll.adsphere.ca bash install.sh
# Options : SEED_B64 (données de départ, base64 d'un JSON {content,progress}), TEAM_PATH (défaut : equipe),
#           REPO (défaut : https://github.com/Adsphere-Marketing/zakroll.git)
set -euo pipefail

DOMAIN="${DOMAIN:-zakroll.adsphere.ca}"
TEAM_PATH="${TEAM_PATH:-equipe}"
REPO="${REPO:-https://github.com/Adsphere-Marketing/zakroll.git}"
DIR=/opt/zakroll

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERREUR : %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Lance ce script en root."
command -v docker >/dev/null || die "Docker est absent."
docker compose version >/dev/null 2>&1 || die "Le plugin « docker compose » est absent."
command -v git >/dev/null || apt-get install -y -q git >/dev/null

say "1/5  Code"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin main && git -C "$DIR" reset -q --hard origin/main
else
  git clone -q "$REPO" "$DIR"
fi
chmod +x "$DIR/update.sh" "$DIR/install.sh" 2>/dev/null || true
mkdir -p "$DIR/data"

say "2/5  Traefik"
TRAEFIK=$(docker ps --format '{{.Names}}' | grep -i traefik | head -1 || true)
[ -n "$TRAEFIK" ] || die "Aucun conteneur Traefik en marche."
TNETS=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$TRAEFIK" | grep -v '^$' || true)
EP=""; EP_HTTP=""; CR=""; NET=""
# D'abord : copier ce qu'un service déjà publié par Traefik utilise (le plus fiable).
for c in $(docker ps --format '{{.Names}}'); do
  [ "$c" = "$TRAEFIK" ] && continue
  [ "$c" = "zakroll" ] && continue
  if [ "$(docker inspect -f '{{index .Config.Labels "traefik.enable"}}' "$c" 2>/dev/null)" = "true" ]; then
    LABELS=$(docker inspect -f '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' "$c")
    cr=$(printf '%s\n' "$LABELS" | grep -E '\.tls\.certresolver=' | head -1 | cut -d= -f2- || true)
    ep=$(printf '%s\n' "$LABELS" | grep -E '^traefik\.http\.routers\.[^.]+\.entrypoints=' | grep -iv 'http\.' | head -1 | cut -d= -f2- | cut -d, -f1 || true)
    if [ -n "$cr" ]; then
      CR="$cr"; [ -n "$ep" ] && EP="$ep"
      CNETS=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$c" | grep -v '^$' || true)
      NET=$(printf '%s\n' "$CNETS" | grep -Fx -f <(printf '%s\n' "$TNETS") | head -1 || true)
      echo "  modèle : $c (résolveur $CR, point d'entrée ${EP:-?}, réseau ${NET:-?})"
      break
    fi
  fi
done
# Ensuite : les arguments de Traefik lui-même.
TARGS=$(docker inspect -f '{{join .Args " "}} {{join .Config.Cmd " "}}' "$TRAEFIK" 2>/dev/null || true)
[ -z "$CR" ] && CR=$(printf '%s' "$TARGS" | grep -oE -- '--certificatesresolvers\.[^.=]+' | head -1 | sed 's/--certificatesresolvers\.//' || true)
if [ -z "$EP" ]; then EP=$(printf '%s' "$TARGS" | grep -oE -- '--entrypoints\.[^.=]+\.address=:443' | head -1 | sed -E 's/--entrypoints\.([^.=]+)\.address=:443/\1/' || true); fi
EP_HTTP=$(printf '%s' "$TARGS" | grep -oE -- '--entrypoints\.[^.=]+\.address=:80' | head -1 | sed -E 's/--entrypoints\.([^.=]+)\.address=:80/\1/' || true)
# Enfin : un fichier de configuration monté dans Traefik.
if [ -z "$CR" ] || [ -z "$EP" ]; then
  for f in $(docker inspect -f '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$TRAEFIK" | grep -E '\.ya?ml$|\.toml$' || true); do
    [ -f "$f" ] || continue
    [ -z "$CR" ] && CR=$(awk 'tolower($0) ~ /certificatesresolvers/ {f=1; next} f && $1 ~ /^[A-Za-z0-9_-]+:$/ {sub(":","",$1); print $1; exit}' "$f" || true)
    [ -z "$EP" ] && EP=$(awk 'tolower($0) ~ /^entrypoints:/ {f=1; next} f && $1 ~ /^[A-Za-z0-9_-]+:$/ {n=$1; sub(":","",n)} f && /:443/ {print n; exit}' "$f" || true)
    [ -z "$EP_HTTP" ] && EP_HTTP=$(awk 'tolower($0) ~ /^entrypoints:/ {f=1; next} f && $1 ~ /^[A-Za-z0-9_-]+:$/ {n=$1; sub(":","",n)} f && /:80"?$/ {print n; exit}' "$f" || true)
  done
fi
[ -n "$NET" ] || NET=$(printf '%s\n' "$TNETS" | grep -v '^bridge$' | head -1 || true)
[ -n "$EP" ] || EP=websecure
[ -n "$EP_HTTP" ] || EP_HTTP=web
[ -n "$NET" ] || die "Impossible de trouver le réseau Docker de Traefik."
if [ -z "$CR" ]; then
  echo "  Résolveur de certificats introuvable. Sortie de diagnostic :"
  docker inspect "$TRAEFIK" | head -200
  die "Colle cette sortie dans la conversation pour que je règle le résolveur à la main."
fi
echo "  réseau=$NET  entrée=$EP  entrée-http=$EP_HTTP  résolveur=$CR"

say "3/5  Configuration"
if [ -f "$DIR/.env" ] && grep -q '^ADMIN_TOKEN=' "$DIR/.env"; then
  ADMIN_TOKEN=$(grep '^ADMIN_TOKEN=' "$DIR/.env" | cut -d= -f2-)
  echo "  jeton admin existant conservé"
else
  ADMIN_TOKEN=$(tr -dc 'a-z0-9' </dev/urandom | head -c 24)
fi
cat >"$DIR/.env" <<EOF
DOMAIN=$DOMAIN
ADMIN_TOKEN=$ADMIN_TOKEN
TEAM_PATH=$TEAM_PATH
TRAEFIK_NETWORK=$NET
ENTRYPOINT=$EP
ENTRYPOINT_HTTP=$EP_HTTP
CERT_RESOLVER=$CR
EOF
chmod 600 "$DIR/.env"
if [ -n "${SEED_B64:-}" ] && [ ! -f "$DIR/data/db.json" ]; then
  printf '%s' "$SEED_B64" | base64 -d >"$DIR/data/seed.json" && echo "  données de départ en place"
fi

say "4/5  Démarrage"
cd "$DIR"
docker compose up -d --force-recreate >/dev/null
cat >/etc/cron.d/zakroll <<'EOF'
* * * * * root bash /opt/zakroll/update.sh >> /var/log/zakroll-update.log 2>&1
EOF
chmod 644 /etc/cron.d/zakroll

say "5/5  Vérification"
ok=""
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/healthz" 2>/dev/null || true)
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 2
done
if [ -n "$ok" ]; then echo "  https://$DOMAIN répond."; else echo "  Pas encore joignable en HTTPS (DNS ou certificat en cours). Réessaie dans quelques minutes : curl -I https://$DOMAIN/healthz"; fi

say "Liens"
echo "  Courtiers : https://$DOMAIN/$TEAM_PATH"
echo "  Admin     : https://$DOMAIN/admin-$ADMIN_TOKEN"
echo
echo "Garde le lien admin pour toi. Le jeton est dans $DIR/.env ; les données dans $DIR/data/db.json."
