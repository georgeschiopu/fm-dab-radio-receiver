# Overview

Extend the current application with an AM demodulator for HF voice bands.

# Goals

- add a new "AM" option at the top, next to the existing FM / NFM / DAB options;
- reuse the NFM-style 1 MS/s waterfall (±0.5 MHz around the tuned frequency) to see adjacent activity;
- envelope-detector demodulation with AGC so strong and weak stations play at a steady level;
- save/load AM frequencies separately from the other modes (per-mode presets, same as NFM);
- AM is intended for HF voice bands (e.g. 40 m) via a ~125 MHz upconverter — tune to `f + 125 MHz`.

# Restrictions

- do not alter any of the existing functionality, especially FM and DAB audio decoding.
