#!/usr/bin/env python3
"""
knob_daemon.py - Turn a USB "volume" knob into a tuning knob.

A USB volume knob is a HID Consumer-Control device, so the OS maps it to the
system mixer (volume) and the browser never sees it. This daemon:

  1. finds the knob's /dev/input/event* device,
  2. grabs it exclusively (so it stops changing the system volume),
  3. re-emits its rotation as REL_WHEEL scroll events on a uinput virtual
     mouse, which the app's scroll-based tuning handler picks up.

Usage:
  sudo ./knob_daemon.py                 # auto-detect the knob
  sudo ./knob_daemon.py --device /dev/input/event4
  sudo ./knob_daemon.py --list          # list input devices + capabilities
  sudo ./knob_daemon.py --invert        # flip the tuning direction
"""

import argparse
import glob
import sys

from evdev import InputDevice, UInput, ecodes


def list_devices():
    for path in sorted(glob.glob('/dev/input/event*')):
        try:
            dev = InputDevice(path)
        except Exception:
            continue
        caps = dev.capabilities(verbose=False)
        keys = caps.get(ecodes.EV_KEY, [])
        rel = caps.get(ecodes.EV_REL, [])
        flags = []
        if ecodes.KEY_VOLUMEUP in keys or ecodes.KEY_VOLUMEDOWN in keys:
            flags.append('volume')
        if ecodes.REL_WHEEL in rel:
            flags.append('wheel')
        if flags:
            print(f"{path}  {dev.name!r}  {' '.join(flags)}")
        dev.close()


def find_knob():
    """Pick the best candidate: has volume keys or a wheel, and isn't a keyboard."""
    best = None
    for path in sorted(glob.glob('/dev/input/event*')):
        try:
            dev = InputDevice(path)
        except Exception:
            continue
        caps = dev.capabilities(verbose=False)
        keys = caps.get(ecodes.EV_KEY, [])
        rel = caps.get(ecodes.EV_REL, [])
        is_kbd = ecodes.KEY_A in keys and ecodes.KEY_Z in keys
        score = 0
        if ecodes.KEY_VOLUMEUP in keys or ecodes.KEY_VOLUMEDOWN in keys:
            score += 3
        if ecodes.REL_WHEEL in rel:
            score += 2
        if is_kbd:
            score -= 5
        if score > 0 and (best is None or score > best[0]):
            best = (score, path, dev.name)
        else:
            dev.close()
    if best is None:
        return None, None
    return best[1], best[2]


def main():
    ap = argparse.ArgumentParser(description="USB volume knob -> tuning knob")
    ap.add_argument('--device', help='Input device path (e.g. /dev/input/event4). Auto-detected if omitted.')
    ap.add_argument('--list', action='store_true', help='List input devices and exit.')
    ap.add_argument('--invert', action='store_true', help='Flip the tuning direction.')
    args = ap.parse_args()

    if args.list:
        list_devices()
        return

    path = args.device
    if not path:
        path, name = find_knob()
        if not path:
            print("No volume/wheel knob found. Run with --list, then pass --device.", file=sys.stderr)
            sys.exit(1)
        print(f"Auto-detected knob: {path} ({name})", file=sys.stderr)

    dev = InputDevice(path)
    dev.grab()  # exclusive: the system volume no longer receives its events
    print(f"Grabbed {path} ({dev.name}). Translating knob -> scroll.", file=sys.stderr)

    ui = UInput(
        {
            ecodes.EV_REL: [ecodes.REL_X, ecodes.REL_Y, ecodes.REL_WHEEL, ecodes.REL_HWHEEL],
        },
        name='tuning-knob-virtual',
    )

    sign = -1 if args.invert else 1

    try:
        for event in dev.read_loop():
            delta = 0
            if event.type == ecodes.EV_KEY:
                if event.value == 0:  # release
                    continue
                if event.code == ecodes.KEY_VOLUMEUP:
                    delta = -1
                elif event.code == ecodes.KEY_VOLUMEDOWN:
                    delta = 1
            elif event.type == ecodes.EV_REL and event.code == ecodes.REL_WHEEL:
                delta = event.value
            if delta == 0:
                continue
            ui.write(ecodes.EV_REL, ecodes.REL_WHEEL, sign * delta)
            ui.syn()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            dev.ungrab()
        except Exception:
            pass
        dev.close()
        ui.close()
        print("Released knob.", file=sys.stderr)


if __name__ == '__main__':
    main()
