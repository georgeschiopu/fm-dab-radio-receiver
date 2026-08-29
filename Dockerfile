# ---- stage 1: build DAB demodulator (eti-cmdline with rtl_tcp input) ----
FROM debian:bookworm-slim AS dab-build
COPY docker/dablin-slideshow.patch /docker/dablin-slideshow.patch
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config zlib1g-dev libfftw3-dev libsndfile1-dev \
    libsamplerate0-dev libmpg123-dev libfaad-dev git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/JvanKatwijk/eti-stuff.git /src/eti-stuff
WORKDIR /src/eti-stuff/eti-cmdline
RUN mkdir build && cd build \
    && cmake .. -DRTL_TCP=ON -DCMAKE_BUILD_TYPE=Release \
    && make -j$(nproc)

# dablin: build the console version from source so MOT slideshows can be
# decoded (the Debian package only enables slideshows in the GUI build).
# We apply a small patch that decodes the MOT slideshow and writes each new
# slide to DAB_SLIDES_DIR (default /tmp/dab-slides) as slide.{jpg,png}.
RUN git clone --depth 1 --branch 1.16.1 https://github.com/Opendigitalradio/dablin.git /src/dablin \
    && cd /src/dablin \
    && git apply /docker/dablin-slideshow.patch \
    && mkdir build && cd build \
    && cmake .. -DDISABLE_SDL=1 -DCMAKE_BUILD_TYPE=Release \
    && make -j$(nproc) dablin \
    && install -m 755 src/dablin /usr/local/bin/dablin

# ---- stage 2: build web client ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# lorarx is the LoRa PHY demodulator used by OpenWebRX+ for Meshtastic.
# Keep the application runtime small by copying only this binary from the
# pinned reference image rather than using the full SoftMbe image as a base.
FROM slechev/openwebrxplus-softmbe@sha256:1be25eaa6ac9bdfb50762dee6ddb20c7639d40ca66bfbedb6915b3689ad266b0 AS meshtastic-build

# dump1090 decodes 1090 MHz ADS-B/Mode S. The server feeds it I/Q over stdin
# (from rtl_tcp) and runs headless, so it is built with the librtlsdr dev
# package present (the binary links it for its RTL path) but launched with
# --ifile, which never touches an RTL device. The matching runtime lib is
# installed in the runtime stage below.
FROM debian:bookworm-slim AS adsb-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential git ca-certificates pkg-config librtlsdr-dev \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v1.14 https://github.com/mutability/dump1090.git /src/dump1090 \
    && cd /src/dump1090 \
    && sed -i -e 's/-Werror //g' -e 's/-O2 -g -Wall/-O2 -g -Wall -fcommon/' Makefile \
    && make \
    && install -m 755 dump1090 /usr/local/bin/dump1090

# ---- stage 3: runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# Runtime libs for the patched dablin and the eti-cmdline-rtl_tcp binary:
# libmpg123-0/libfaad2 (dablin), libsndfile1/libsamplerate0/libfftw3-single3 (eti-cmdline).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libmpg123-0 libfaad2 libsndfile1 libsamplerate0 libfftw3-single3 \
    librtlsdr0 libusb-1.0-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=dab-build /src/eti-stuff/eti-cmdline/build/eti-cmdline-rtl_tcp /usr/local/bin/eti-cmdline-rtl_tcp
COPY --from=dab-build /usr/local/bin/dablin /usr/local/bin/dablin
COPY --from=meshtastic-build /usr/bin/lorarx /usr/local/bin/lorarx
COPY --from=adsb-build /usr/local/bin/dump1090 /usr/local/bin/dump1090
COPY --from=build /app/server ./server
COPY --from=build /app/client/dist ./client/dist
RUN useradd -r -s /usr/sbin/nologin sdr && mkdir -p /data && chown -R sdr:sdr /data && chown -R sdr /app
USER sdr
EXPOSE 8080
CMD ["node", "server/index.js"]
