# Own server (Timeweb Cloud)

Ubuntu 24.04, Node 22 as a systemd service behind Caddy (HTTPS via Let's Encrypt).

1. `bash deploy/setup.sh <domain>` as root — packages, firewall (22/80/443), SSH keys only, auto security updates,
   user `faq626`, code in `/opt/faq626`, data in `/var/lib/faq626/data`, service and Caddy.
2. Write secrets to `/etc/faq626.env` (mode 600, never in git):
   `BITRIX_WEBHOOK`, `DASHBOARD_PASSWORD`, `MATTERMOST_URL`, `MATTERMOST_TOKEN`, `ALERT_MM_USER`, `PUBLIC_URL`.
3. `systemctl start faq626`; logs: `journalctl -u faq626 -f`.

Auto-hints (GigaChat — Claude isn't available from Russia): `bash deploy/setup-hints.sh` installs the Russian root CA
and `faq626-hints.timer` (every 5 min; after changing the timer file re-run the two `install` lines and `systemctl daemon-reload`); the key goes to `/etc/faq626-gigachat.env` (`GIGACHAT_AUTH_KEY`, `GIGACHAT_SCOPE`, 600).
Manual run: `systemctl start faq626-hints`; log: `journalctl -u faq626-hints -n 20`.

Deploy a new version: `git -C /opt/faq626 fetch -q && git -C /opt/faq626 reset -q --hard <sha> && systemctl restart faq626`.
