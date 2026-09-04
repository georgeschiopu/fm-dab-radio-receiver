# Utilities

Helper scripts for the kiosk / Raspberry Pi setup.

## USB volume knob -> tuning knob

`knob_daemon.py` turns a USB "volume" knob (a HID Consumer-Control device) into
a **tuning knob** for the radio.

A USB volume knob is a HID Consumer-Control device, so the OS routes its
reports straight to the system mixer and the browser never sees them. The
daemon fixes that by:

1. Finding the knob's `/dev/input/event*` device (auto-detected, or set with
   `--device`).
2. **Grabbing** it exclusively, so it no longer changes the system volume.
3. Re-emitting each notch as a **`REL_WHEEL` scroll event on a `uinput`
   virtual mouse**. The app's global scroll tuning handler (see the
   `feature/usb-knob-tuning` branch) receives these and tunes the radio.

So the chain is: **knob -> daemon -> virtual scroll -> browser -> tune**.

### Requirements

- Linux (Debian / Raspberry Pi OS).
- `python3-evdev` (it includes `UInput`).
- `uinput` kernel module.
- Root access (or membership in the `input` group) to read `/dev/input` and
  write `/dev/uinput`.

### Run once

```sh
sudo apt install python3-evdev
sudo modprobe uinput

# List input devices and find the knob (look for a 'volume' or 'wheel' flag):
sudo ./knob_daemon.py --list

# Run it (auto-detect):
sudo ./knob_daemon.py

# ...or point at a specific device:
sudo ./knob_daemon.py --device /dev/input/event4

# If the tuning direction feels backwards:
sudo ./knob_daemon.py --invert
```

### Autostart on boot

```sh
sudo ./install-knob-daemon.sh
sudo systemctl start knob-daemon
```

The install script copies the daemon to `/usr/local/bin`, installs
`knob-daemon.service` (a systemd unit), adds a udev rule for non-root
`/dev/uinput` access, and enables the service.

### Notes

- The daemon must run as **root** (or a user in the `input` group) to grab
  `/dev/input` and write `/dev/uinput`.
- The **browser must be the active window** for the virtual scroll to reach
  it — that's the case in full-screen kiosk mode.
- This relies on the global scroll/arrow-key tuning handler added in the
  `feature/usb-knob-tuning` branch (PR #25). Without it, the scroll events do
  nothing.
- If your knob is programmable and can be set to send **arrow keys** instead
  of volume, the app's arrow-key handler already covers that and you don't
  need this daemon at all.
