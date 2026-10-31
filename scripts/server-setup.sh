#!/usr/bin/env bash
# One-time (and repeatable) setup of Hireriv on a VPS that already runs
# Docker and Caddy, e.g. next to another site. Run it on the server:
#   bash <(curl -fsSL https://raw.githubusercontent.com/gopalrai165-rgb/hireriv-/main/scripts/server-setup.sh)
# It downloads or updates the code in ~/hireriv, asks for the settings the
# first time (kept in ~/hireriv/.env), starts the site on 127.0.0.1:3004 and
# adds hireriv.in to Caddy without touching the sites already there.
set -euo pipefail

REPO=https://github.com/gopalrai165-rgb/hireriv-.git
DIR="$HOME/hireriv"
DOMAIN=hireriv.in
CADDYFILE=/etc/caddy/Caddyfile

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mSTOPPED: %s\033[0m\n' "$1"; exit 1; }
ask() { local v; read -r -p "$1: " v </dev/tty; printf '%s' "$v"; }
ask_secret() { local v; read -r -s -p "$1: " v </dev/tty; echo >/dev/tty; printf '%s' "$v"; }

say "1/5 Getting the code"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi
cd "$DIR"

say "2/5 Settings (.env)"
if [ -f .env ]; then
  echo "Keeping the existing .env"
else
  echo "Answer a few questions. Nothing you type here leaves this server."
  while :; do
    ADMIN_PASS=$(ask_secret "Admin password for /admin (12+ characters)")
    [ ${#ADMIN_PASS} -ge 12 ] || { echo "Too short, try again."; continue; }
    case "$ADMIN_PASS" in *"'"*) echo "Please don't use the ' character."; continue;; esac
    break
  done
  SMTP_USER=$(ask "Email address that sends the site's emails (e.g. you@gmail.com)")
  SMTP_HOST=$(ask "SMTP server [smtp.gmail.com]"); SMTP_HOST=${SMTP_HOST:-smtp.gmail.com}
  SMTP_PORT=$(ask "SMTP port [587]"); SMTP_PORT=${SMTP_PORT:-587}
  while :; do
    SMTP_PASS=$(ask_secret "SMTP password (for Gmail: a 16-letter App Password)")
    case "$SMTP_PASS" in *"'"*) echo "Please don't use the ' character."; continue;; esac
    [ -n "$SMTP_PASS" ] && break
  done
  NOTIFY_EMAIL=$(ask "Email that receives new applications [$SMTP_USER]"); NOTIFY_EMAIL=${NOTIFY_EMAIL:-$SMTP_USER}
  FILE_KEY=$(openssl rand -hex 32)

  grep -v -E '^(SITE_URL|PORT|NODE_ENV|ADMIN_PASS|SMTP_HOST|SMTP_PORT|SMTP_USER|SMTP_PASS|MAIL_FROM|NOTIFY_EMAIL|TRUST_PROXY|FILE_ENCRYPTION_KEY)=' .env.example > .env
  cat >> .env <<EOF

# ---- Set by scripts/server-setup.sh ----
SITE_URL=https://$DOMAIN
NODE_ENV=production
PORT=3004
TRUST_PROXY=1
ADMIN_PASS='$ADMIN_PASS'
SMTP_HOST=$SMTP_HOST
SMTP_PORT=$SMTP_PORT
SMTP_USER=$SMTP_USER
SMTP_PASS='$SMTP_PASS'
MAIL_FROM='"Hireriv" <$SMTP_USER>'
NOTIFY_EMAIL=$NOTIFY_EMAIL
FILE_ENCRYPTION_KEY=$FILE_KEY
EOF
  chmod 600 .env
  printf '\n\033[1;33mSAVE THIS KEY somewhere safe (password manager). Without it uploaded resumes cannot be opened:\n%s\033[0m\n' "$FILE_KEY"
  read -r -p "Press Enter once you have saved it... " _ </dev/tty
fi

say "3/5 Checking the settings"
sudo docker compose build
sudo docker compose run --rm hireriv node config-check.js \
  || fail "fix the settings above with: nano ~/hireriv/.env   then run this script again"

say "4/5 Starting Hireriv"
sudo docker compose up -d
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3004/healthz >/dev/null 2>&1; then echo "Hireriv is running."; break; fi
  [ "$i" -eq 30 ] && { sudo docker compose logs --tail 50; fail "Hireriv did not start (log above)"; }
  sleep 2
done

say "5/5 Adding $DOMAIN to Caddy"
if sudo grep -q "^$DOMAIN" "$CADDYFILE"; then
  echo "Caddy already has $DOMAIN"
else
  BACKUP="$CADDYFILE.backup-$(date +%Y%m%d-%H%M%S)"
  sudo cp "$CADDYFILE" "$BACKUP"
  sudo tee -a "$CADDYFILE" >/dev/null <<EOF

$DOMAIN {
	reverse_proxy localhost:3004
}
www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
EOF
  if ! sudo caddy validate --config "$CADDYFILE" --adapter caddyfile; then
    sudo cp "$BACKUP" "$CADDYFILE"
    fail "Caddy rejected the change, so the old Caddyfile was put back. Nothing else changed."
  fi
fi
sudo systemctl reload caddy

say "Done"
echo "Open https://$DOMAIN (the certificate can take a minute once DNS points here)."
echo "Admin: https://$DOMAIN/admin  (user: admin)"
echo "Update later:  cd ~/hireriv && git pull && sudo docker compose up -d --build"
