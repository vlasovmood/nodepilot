# Static Linux (musl) build of NodePilot with the embedded web UI.
#   docker build -t nodepilot .
#   docker run -d -p 7780:7780 -v nodepilot-data:/var/lib/nodepilot nodepilot
# Export only the binary:
#   docker build --target export --output dist .

FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci || npm install
COPY web/ ./
RUN npm run build

FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends musl-tools && rm -rf /var/lib/apt/lists/* \
    && rustup target add x86_64-unknown-linux-musl
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY --from=web /src/web/dist ./web/dist
RUN cargo build --release --locked --target x86_64-unknown-linux-musl -p nodepilot \
    && cp target/x86_64-unknown-linux-musl/release/nodepilot /nodepilot

FROM scratch AS export
COPY --from=build /nodepilot /nodepilot

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --system --home /var/lib/nodepilot --shell /usr/sbin/nologin nodepilot \
    && mkdir -p /var/lib/nodepilot && chown nodepilot:nodepilot /var/lib/nodepilot
COPY --from=build /nodepilot /usr/local/bin/nodepilot
USER nodepilot
# Containers update by pulling a new image, not via self-update.
ENV NODEPILOT_DATA=/var/lib/nodepilot NODEPILOT_LISTEN=0.0.0.0:7780 NODEPILOT_IN_DOCKER=1
VOLUME /var/lib/nodepilot
EXPOSE 7780
ENTRYPOINT ["/usr/local/bin/nodepilot"]
CMD ["serve"]
