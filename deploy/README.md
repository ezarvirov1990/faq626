# Own server (Timeweb Cloud)

Ubuntu 24.04, Node 22 as a systemd service behind Caddy (HTTPS via Let's Encrypt).

1. `bash deploy/setup.sh <domain>` as root — packages, firewall (22/80/443), SSH keys only, auto security updates,
   user `faq626`, code in `/opt/faq626`, data in `/var/lib/faq626/data`, service and Caddy.
2. Write secrets to `/etc/faq626.env` (mode 600, never in git):
   `BITRIX_WEBHOOK`, `DASHBOARD_PASSWORD`, `MATTERMOST_URL`, `MATTERMOST_TOKEN`, `ALERT_MM_USER`, `PUBLIC_URL`.
3. `systemctl start faq626`; logs: `journalctl -u faq626 -f`.

Auto-hints: `bash deploy/setup-hints.sh` installs Claude Code for `faq626` and the hourly `faq626-hints.timer`;
the subscription token (`claude setup-token`) goes to `/etc/faq626-claude.env` as `CLAUDE_CODE_OAUTH_TOKEN=...` (600).
Manual run: `systemctl start faq626-hints`; dry run: `sudo -u faq626 env $(cat /etc/faq626.env /etc/faq626-claude.env | xargs) HINTS_DRY_RUN=1 node hints-auto.js`.

Deploy a new version: `git -C /opt/faq626 fetch -q && git -C /opt/faq626 reset -q --hard <sha> && systemctl restart faq626`.
