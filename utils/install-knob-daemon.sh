#!/usr/bin/env bash
# Install the USB knob daemon and its systemd unit so it auto-starts on boot.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sudo cp "$DIR/knob_daemon.py" /usr/local/bin/knob_daemon.py
sudo chmod +x /usr/local/bin/knob_daemon.py

sudo cp "$DIR/knob-daemon.service" /etc/systemd/system/knob-daemon.service

# Allow non-root uinput access (optional, but handy for a kiosk user).
if [ ! -f /etc/udev/rules.d/70-uinput.rules ]; then
  echo 'KERNEL=="uinput", MODE="0660", GROUP="input"' | sudo tee /etc/udev/rules.d/70-uinput.rules >/dev/null
  sudo udevadm control --reload-rules
fi

sudo systemctl daemon-reload
sudo systemctl enable knob-daemon
echo "Installed. Start with: sudo systemctl start knob-daemon"
