#!/usr/bin/env bash
# One-time setup of an Ubuntu 24.04 server for the dashboard (run as root: bash setup.sh <domain>).
# Secrets are NOT here: /etc/faq626.env is written separately (see deploy/README.md).
set -euo pipefail
DOMAIN="${1:?usage: setup.sh <domain>}"
REPO="https://github.com/ezarvirov1990/faq626.git"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq git curl ufw unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https gnupg

# Security updates install themselves
dpkg-reconfigure -f noninteractive unattended-upgrades

# Firewall: SSH and HTTP(S) only
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# SSH: keys only
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh || systemctl reload sshd

# Node.js 22 (Ubuntu ships an older one)
if ! node -v 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi

# App user, code and data
id faq626 >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/faq626 --shell /usr/sbin/nologin faq626
install -d -o faq626 -g faq626 -m 700 /var/lib/faq626/data
if [ ! -d /opt/faq626/.git ]; then git clone -q "$REPO" /opt/faq626; fi
git -C /opt/faq626 config --global --add safe.directory /opt/faq626 || true
touch /etc/faq626.env && chmod 600 /etc/faq626.env

install -m 644 /opt/faq626/deploy/faq626.service /etc/systemd/system/faq626.service
systemctl daemon-reload
systemctl enable faq626

# Caddy: HTTPS with an automatic Let's Encrypt certificate
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -yq caddy
fi
sed "s/{{DOMAIN}}/$DOMAIN/" /opt/faq626/deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "setup done: fill /etc/faq626.env, then: systemctl start faq626"
