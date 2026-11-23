#!/bin/sh
# Install NodePilot as a systemd service on Ubuntu/Debian.
#   sudo ./install.sh ./nodepilot
set -eu

BIN="${1:-./nodepilot}"
UNIT_SRC="$(dirname "$0")/nodepilot.service"

if [ "$(id -u)" -ne 0 ]; then
    echo "run as root: sudo $0 $BIN" >&2
    exit 1
fi
[ -x "$BIN" ] || { echo "binary not found or not executable: $BIN" >&2; exit 1; }

if ! id nodepilot >/dev/null 2>&1; then
    useradd --system --home /var/lib/nodepilot --shell /usr/sbin/nologin nodepilot
fi
# The binary lives in the data dir so the service can replace it on self-update;
# /usr/local/bin gets a symlink for the CLI.
install -d -m 0700 -o nodepilot -g nodepilot /var/lib/nodepilot
install -d -m 0755 -o nodepilot -g nodepilot /var/lib/nodepilot/bin
install -m 0755 -o nodepilot -g nodepilot "$BIN" /var/lib/nodepilot/bin/nodepilot
ln -sf /var/lib/nodepilot/bin/nodepilot /usr/local/bin/nodepilot
install -d -m 0755 /etc/nodepilot
[ -f /etc/nodepilot/nodepilot.env ] || cat > /etc/nodepilot/nodepilot.env <<'EOF'
# NODEPILOT_LISTEN=127.0.0.1:7780
# NODEPILOT_SECURE_COOKIES=true
# NODEPILOT_STATS_INTERVAL=30
# NODEPILOT_METRICS_RETENTION_DAYS=7
EOF
install -m 0644 "$UNIT_SRC" /etc/systemd/system/nodepilot.service
systemctl daemon-reload
systemctl enable nodepilot
systemctl restart nodepilot
systemctl --no-pager status nodepilot | head -n 5
echo
echo "NodePilot is running. Open the panel and create the admin account."
echo "Data: /var/lib/nodepilot  (back up master.key — without it stored credentials cannot be decrypted)"
if command -v systemd-creds >/dev/null 2>&1 && systemd-creds has-tpm2 >/dev/null 2>&1; then
    echo
    echo "This machine has a TPM 2.0. Seal the master key into it (recommended):"
    echo "  sudo $(dirname "$0")/seal-master-key.sh --backup-to /root/nodepilot-master.key.backup"
fi
