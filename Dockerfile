# ---- stage 1: build DAB demodulator (eti-cmdline with rtl_tcp input) ----
FROM debian:bookworm-slim AS dab-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake zlib1g-dev libfftw3-dev libsndfile1-dev \
    libsamplerate0-dev git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/JvanKatwijk/eti-stuff.git /src/eti-stuff
WORKDIR /src/eti-stuff/eti-cmdline
RUN mkdir build && cd build \
    && cmake .. -DRTL_TCP=ON -DCMAKE_BUILD_TYPE=Release \
    && make -j$(nproc)

# ---- stage 2: build web client ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- stage 3: runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# dablin pulls in libsndfile1, libsamplerate0, libfftw3-single0 and friends,
# which are also the shared-library deps of the eti-cmdline-rtl_tcp binary.
RUN apt-get update && apt-get install -y --no-install-recommends dablin \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=dab-build /src/eti-stuff/eti-cmdline/build/eti-cmdline-rtl_tcp /usr/local/bin/eti-cmdline-rtl_tcp
COPY --from=build /app/server ./server
COPY --from=build /app/client/dist ./client/dist
RUN useradd -r -s /usr/sbin/nologin sdr && chown -R sdr /app
USER sdr
EXPOSE 8080
CMD ["node", "server/index.js"]
