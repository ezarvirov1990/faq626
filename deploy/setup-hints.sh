#!/usr/bin/env bash
# Auto-hints on the server (run as root after setup.sh): Russian root CA for GigaChat + the 5-minute timer.
# The GigaChat key goes to /etc/faq626-gigachat.env (mode 600):
#   GIGACHAT_AUTH_KEY=<Authorization Key from developers.sber.ru>
#   GIGACHAT_SCOPE=GIGACHAT_API_PERS | GIGACHAT_API_B2B | GIGACHAT_API_CORP
set -euo pipefail
# Sber's API certificates are issued by the Ministry of Digital Development CA (not in Node's bundle)
CA=/usr/local/share/ca-certificates/russian_trusted_ca.crt
if [ ! -s "$CA" ]; then
  tmp=$(mktemp)
  curl -fsSL https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt > "$tmp"
  echo >> "$tmp"
  curl -fsSL https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt >> "$tmp"
  grep -q "BEGIN CERTIFICATE" "$tmp"
  install -m 644 "$tmp" "$CA" && rm -f "$tmp"
  update-ca-certificates >/dev/null
fi
touch /etc/faq626-gigachat.env && chmod 600 /etc/faq626-gigachat.env
install -m 644 /opt/faq626/deploy/faq626-hints.service /etc/systemd/system/faq626-hints.service
install -m 644 /opt/faq626/deploy/faq626-hints.timer /etc/systemd/system/faq626-hints.timer
systemctl daemon-reload
echo "hints setup done: fill /etc/faq626-gigachat.env, then: systemctl enable --now faq626-hints.timer"
