#!/usr/bin/env bash
# Auto-hints on the server (run as root after setup.sh): Claude Code for user faq626 + hourly timer.
# The subscription token (claude setup-token) goes to /etc/faq626-claude.env as CLAUDE_CODE_OAUTH_TOKEN=... (mode 600).
set -euo pipefail
if [ ! -x /var/lib/faq626/.local/bin/claude ]; then
  sudo -u faq626 -H bash -c 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null
fi
sudo -u faq626 -H /var/lib/faq626/.local/bin/claude --version
touch /etc/faq626-claude.env && chmod 600 /etc/faq626-claude.env
install -m 644 /opt/faq626/deploy/faq626-hints.service /etc/systemd/system/faq626-hints.service
install -m 644 /opt/faq626/deploy/faq626-hints.timer /etc/systemd/system/faq626-hints.timer
systemctl daemon-reload
echo "hints setup done: put CLAUDE_CODE_OAUTH_TOKEN into /etc/faq626-claude.env, then: systemctl enable --now faq626-hints.timer"
