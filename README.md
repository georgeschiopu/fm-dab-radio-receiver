# FM / NFM / HF (AM · SSB · CW) / DAB / Meshtastic / ADS-B Radio Receiver

A lightweight web-based radio receiver for **broadcast FM**, **narrowband FM (NFM)** for amateur radio, **HF** (0–30 MHz) with **AM / USB / LSB / CW** demodulators, **DAB/DAB+** (digital radio), **Meshtastic** LoRa and **ADS-B** aircraft, fed by a remote [rtl_tcp](https://github.com/keenerd/rtl-sdr-blog) SDR server.

The Node.js backend demodulates FM/NFM/HF IQ samples in-process and decodes DAB via an `eti-cmdline-rtl_tcp | dablin` pipeline; Meshtastic and ADS-B are decoded by `lorarx` and `dump1090` child processes. A small React client streams live audio and shows a spectrum analyzer (FM), a waterfall centered on the tuned frequency (NFM/HF), the current DAB ensemble/service, Meshtastic telemetry, or the ADS-B aircraft map/table.

## Features

- **FM mode** — in-process FFT-based FM demodulator (288 kHz sample rate), signal + audio meters, live spectrum analyzer.
- **NFM mode** — narrowband FM for amateur bands: 1 MS/s rtl_tcp so the **±0.5 MHz waterfall** (centered on the tuned frequency) shows adjacent activity. In-process NFM demod (4 kHz voice bandwidth) with **AGC** for a steady level and a manual **Squelch** slider (off by default, NFM-only) that mutes the noise floor when no carrier is locked.
- **HF mode** — the 0–30 MHz band (e.g. 40 m, via a 125 MHz upconverter), sharing the 1 MS/s **±0.5 MHz waterfall** as NFM. Four **demodulator buttons** (AM, USB, LSB, CW) sit above the saved-stations panel and switch the demodulator for the tuned frequency without retuning the SDR; each saved station remembers its own demodulator. Tune to `f + 125 MHz` (upconverter LO) when using a Ham It Up-style converter.
  - **AM** — in-process envelope-detector demod (√(I²+Q²)) with a DC blocker, 5 kHz audio bandwidth, **AGC** for a steady level.
  - **USB / LSB** — single-sideband demod via a complex band-pass that mixes the wanted sideband to baseband, rejects the image, and restores the audio pitch (also **AGC**).
  - **CW** — the SSB (USB) demodulator feeding a **morse decoder** that detects keyed tone on/off (concentration-based, robust to AGC), times dots/dashes against an adaptive dot length, and displays the decoded text **on the waterfall**.
- **Meshtastic mode** — EU868 LoRa packet demodulation at 869.525 MHz using `lorarx`, with text messages, node positions, and device/environment telemetry. The built-in default key and encrypted per-account custom PSKs are supported.
- **ADS-B mode** — 1090 MHz ADS-B / Mode S decoding via `dump1090` (fed from the same rtl_tcp IQ stream). Detected aircraft appear on an interactive **Leaflet + OpenStreetMap** map centred on `HOME_LAT`/`HOME_LON` (with a `25–200 km` range selector) plus a rich table: ICAO (linked to ADS-B Exchange), callsign, country flag, thumbnail photo, registration, type, operator, airborne/ground status (✓/✗), altitude, speed, track, squawk, position and age. Registration/type/operator/photo are enriched from the free [adsbdb](https://adsbdb.com), and the table is enriched with **ADS-B Exchange** links and start/register sorting (desc → asc → stop). Aircraft not heard for **10 minutes** are dropped. When the receiver hasn't decoded a position, it's fetched from the keyless **OpenSky Network** so the table/map have no empty fields.
- **DAB mode** — full ETI decode chain (`eti-cmdline-rtl_tcp` → `dablin`) producing 48 kHz audio; live ensemble name, playing service and SNR on a DAB channel selector (5A–13F), plus a **Station dropdown** to pick a specific service from the tuned ensemble (or "first station found").
- **Presets** — save/load stations in the browser (localStorage), kept **separately per mode**. DAB presets remember both the channel and the selected station, so clicking one tunes the ensemble and plays that service (`dablin -l`). HF presets remember the **demodulator** used on that frequency (AM/USB/LSB/CW), so clicking one tunes it and selects the matching demod. FM/NFM/HF presets show a station logo when available: the backend lazily looks each saved station up in the free [radio-browser.info](https://www.radio-browser.info) community database (by name + frequency, GB-first), downloads the favicon to `server/logos/fm/`, and caches the result. No API key needed; downloaded logos are gitignored.
- **Remote SDR** — works with any `rtl_tcp` server on your network (or localhost).

## Prerequisites

- **Docker** (with `docker compose`) — for the recommended setup.
- An **rtl_tcp server** streaming IQ from a DAB-capable RTL-SDR stick, e.g.:

  ```sh
  rtl_tcp -a 192.168.0.10   # listen on all interfaces, port 1234
  ```

  The server must be reachable from the receiver container.

## Quick start (Docker)

```sh
git clone git@github.com:georgeschiopu/fm-dab-radio-receiver.git
cd fm-dab-radio-receiver

# point the container at your rtl_tcp host
export RTL_TCP_HOST=192.168.0.10

docker compose up -d --build
```

Open http://localhost:8080 , press **Play** and start listening.

> The first build clones `JvanKatwijk/eti-stuff` and compiles `eti-cmdline-rtl_tcp` (a few minutes), then installs `dablin` — both are cached for later builds.

## Configuration

All options are environment variables (see `docker-compose.yml`):

| Variable           | Default      | Description                                             |
| ------------------ | ------------ | ------------------------------------------------------- |
| `RTL_TCP_HOST`     | `192.168.0.6`| Host running the rtl_tcp server                         |
| `RTL_TCP_PORT`     | `1234`       | rtl_tcp port                                            |
| `RTL_TCP_FREQ`     | `95.1e6`     | Initial FM frequency (Hz)                               |
| `RTL_TCP_GAIN`     | `40`         | Tuner gain in dB (auto gain overloads strong signals)   |
| `RTL_TCP_MODE`     | `fm`         | Initial receiver mode: `fm`, `nfm`, `am` (the HF band), `dab`, `meshtastic` or `adsb` |
| `RTL_TCP_DAB_FREQ` | `216.928e6`  | Initial DAB ensemble frequency (Hz), mapped to a block  |
| `RTL_TCP_NFM_FREQ` | `145.0e6`    | Initial NFM frequency (Hz)                              |
| `RTL_TCP_AM_FREQ`  | `7.1e6`      | Initial HF (AM/USB/LSB/CW) frequency (Hz)               |
| `RTL_TCP_MESHTASTIC_FREQ` | `869.525e6` | Initial EU868 Meshtastic frequency (Hz)            |
| `RTL_TCP_ADSB_FREQ` | `1090e6`    | Initial ADS-B frequency (Hz)                        |
| `HOME_LAT` / `HOME_LON` | _(unset)_ | Fixed map centre for ADS-B (decimal degrees); if unset the map tracks the heard fleet centroid |
| `ADSB_SBS_PORT` | `10001`    | Local TCP port dump1090 emits SBS-1 aircraft on    |
| `ADSB_BIN` | `dump1090` | Override the dump1090 binary path                  |
| `PORT`             | `8080`       | Web UI port                                             |

> ADS-B enrichment calls [adsbdb](https://adsbdb.com) and the [OpenSky Network](https://opensky-network.org) from the **browser** (both free/keyless), so the client machine needs internet for the aircraft photos/metadata and OpenSky position fill.

Example with a DAB default:

```sh
RTL_TCP_HOST=192.168.0.10 RTL_TCP_MODE=dab RTL_TCP_DAB_FREQ=227.36e6 docker compose up -d
```

## Development

Requires Node.js ≥ 18.

```sh
npm install

# run server + client (Vite dev server with proxy to :8080)
npm run dev

# or run the pieces separately
npm run dev:server   # Node backend on :8080
npm run dev:client   # Vite on :5173 (proxies /api and /ws to :8080)
```

The dev backend spawns `eti-cmdline-rtl_tcp` and `dablin` from `$PATH` (set `ETI_CMDLINE_BIN`/`DABLIN_BIN` to override). To test DAB locally without Docker, build eti-cmdline first:

```sh
git clone https://github.com/JvanKatwijk/eti-stuff.git
cd eti-stuff/eti-cmdline
cmake . -DRTL_TCP=ON && make          # needs build-essential, cmake,
                                       # zlib1g-dev, libfftw3-dev,
                                       # libsndfile1-dev, libsamplerate0-dev
sudo apt install dablin                # ETI -> PCM decoder
```

### Tests

```sh
npm test
```

Runs offline unit tests against a fake rtl_tcp server (protocol + FM/NFM/AM demod + SSB (USB/LSB) + CW morse decoding + AGC/squelch + resampler + spectrum + DAB channel map + Meshtastic parsing + ADS-B SBS-1 parsing + preset demod persistence).

## How it works

- **FM**: the backend connects to rtl_tcp at 288 kS/s, demodulates FM with a zero-IF FFT pipeline (120 Hz bins), and streams mono 48 kHz int16 PCM over a WebSocket.
- **NFM**: the backend connects at 1 MS/s so the whole ±0.5 MHz waterfall span is visible; demodulates narrowband FM with a 4 kHz voice bandwidth, applies AGC to hold a steady audio level, optionally gates the output with a carrier-lock squelch, and resamples 50 kHz → 48 kHz server-side before streaming (so voices keep the correct pitch).
- **HF (AM/USB/LSB/CW)**: the backend connects at the same 1 MS/s as NFM (shared waterfall) and picks the demodulator per the tuned frequency. **AM** uses a complex-envelope detector (√(I²+Q²)) with a DC blocker that strips the carrier, low-passes to 5 kHz, applies AGC, and resamples 50 kHz → 48 kHz. **USB/LSB** use a single-sideband decoder: the complex baseband is mixed down (or up, for LSB) by a BFO so the wanted sideband sits at DC, the image sideband is filtered out, then mixed back to restore the original audio pitch and the real part taken as the audio (AGC'd, 50 kHz → 48 kHz). **CW** reuses the USB SSB decoder and feeds the audio to a morse decoder that uses a Goertzel "concentration" metric (a keyed tone concentrates energy in one bin, noise spreads it) to detect key on/off, times dots/dashes against an adaptive dot length, and emits the decoded text, which the client draws over the waterfall. Changing demodulator never retunes the hardware because all four share the 1 MS/s front-end.
- **Meshtastic**: the backend pipes raw 1 MS/s unsigned IQ into `lorarx` with EU868 Meshtastic settings (250 kHz bandwidth, SF7–SF11), decrypts the JSON packet payload with the selected account key, and decodes text, position, node info, and telemetry protobuf fields.
- **DAB**: the backend runs `eti-cmdline-rtl_tcp -H host -C <channel>` (rtl_tcp at 2.048 MS/s) and pipes ETI frames into `dablin` (PCM to stdout), which emits the audio at the service's native rate/format (48/32/24 kHz, mono/stereo, float32 or int16); the server downmixes to mono int16 and the client plays it at the reported rate. `-l <label>` selects a specific station from the ensemble's FIC listing.
- **ADS-B**: the backend pipes raw 2 MS/s unsigned IQ into `dump1090 --ifile -` (all other listeners disabled), reads its SBS-1 output over a local TCP port, and keeps a rolling list of aircraft (10-minute TTL, also tracking first-seen time). The frontend enriches each aircraft from adsbdb (registration/type/operator/photo), fills any position the receiver missed from OpenSky, links to ADS-B Exchange, and lets you sort the ICAO and Age columns.
- The client uses a Web Audio `AudioContext` at 48 kHz for gapless playback and renders spectrum/waterfall lines on a canvas.

### WebSocket protocol

- Text `status` messages carry `mode`, `connected`, `freq`, `signal`, `audio`, `squelch`, the HF `demod` (AM/USB/LSB/CW), and DAB fields (`channel`, `service`, `ensemble`, `snr`). Meshtastic packets use `{type: "meshtastic", packet}` messages; ADS-B aircraft use `{type: "adsb", aircraft: [...]}`, where each aircraft has `icao`, optional `callsign`/`altitude`/`speed`/`track`/`lat`/`lon`/`verticalRate`/`squawk`/`alert`/`emergency`/`spi`/`onGround`, plus `age` (seconds since last message) and `addedAge` (seconds since first heard). CW decoding broadcasts `{type: "cw", text}` with the decoded (rolling) morse text.
- Client → server text ops: `tune` (mode, frequency, gain, optional HF `demod`, DAB `service` and NFM `squelch`), `demod` (switch the HF demodulator), `gain`, `squelch`, `meshtasticKey`, `stop`.
- Binary frames: `0x01` = PCM int16 LE (mono 48 kHz), `0x02` = spectrum dB line (`uint16 LE` length prefix).

## Project layout

```
server/
  index.js        Express + WebSocket server, protocol handling
  audioStream.js  mode-aware stream manager (FM / NFM / HF / DAB), HF demodulator switching
  dab.js          DAB pipeline: eti-cmdline-rtl_tcp | dablin, channel map
  meshtastic.js   LoRa packet parsing, decryption, and Meshtastic protobuf fields
  meshtasticReceiver.js  lorarx child-process stream adapter
  adsb.js         SBS-1 BaseStation parsing and rolling aircraft tracker
  adsbReceiver.js dump1090 child-process stream adapter (reads rtl_tcp IQ, SBS-1 out)
  userSettings.js account-scoped encrypted Meshtastic key settings
  cw.js           CW (morse) decoder: Goertzel tone detection + adaptive timing
  dsp.js          FM/NFM/AM/SSB (USB/LSB) demodulators (AGC, squelch, 50k->48k resampler)
  rtlTcp.js       rtl_tcp client (single-instance, exclusive connection)
  spectrum.js     spectrum analyzer (FFT -> dB lines)
  test.test.js    offline unit tests
client/
  src/App.jsx         UI: mode dropdown, tuner, presets, spectrum / waterfall / DAB / ADS-B panels
  src/AdsbMap.jsx     Leaflet + OpenStreetMap aircraft map (ADS-B)
  src/AdsbTable.jsx   aircraft table (enrichment, ADS-B Exchange links, sorting)
  src/icaoCountry.js  ICAO 24-bit address -> country flag mapping
  src/adsbEnrich.js   adsbdb enrichment + OpenSky position fill
  src/audio.js        Web Audio playback
  src/SpectrumAnalyzer.jsx  smooth FM spectrum canvas
  src/Waterfall.jsx   NFM waterfall canvas
Dockerfile        multi-stage: build eti-stuff + client, runtime with dablin + lorarx
docker-compose.yml
```
