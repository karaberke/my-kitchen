# syntax=docker/dockerfile:1.7
# Build the official source at an immutable release commit; no third-party proxy image.
FROM golang:1.27.3-alpine3.24@sha256:b8c9b82affbbb82a020bbcf998dad2ba9516944ac7e883524642a481a9505e9c AS build
ENV SMOKESCREEN_REVISION=609eb8931420453daf5893509be0b25b21bd9edb \
    CGO_ENABLED=0 GOTOOLCHAIN=local
RUN apk add --no-cache git \
    && git init /src \
    && git -C /src remote add origin https://github.com/stripe/smokescreen.git \
    && git -C /src fetch --depth=1 origin "$SMOKESCREEN_REVISION" \
    && git -C /src checkout --detach FETCH_HEAD \
    && test "$(git -C /src rev-parse HEAD)" = "$SMOKESCREEN_REVISION"
WORKDIR /src
# Security fixes for CVE-2025-65637, CVE-2026-78669 and CVE-2026-56851.
# Only the cloned module manifests change; the application source commit stays pinned.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go get github.com/sirupsen/logrus@v1.9.3 golang.org/x/net@v0.60.0 golang.org/x/text@v0.42.0 \
    && go mod download \
    && go mod verify \
    && go test -mod=readonly ./... \
    && go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/smokescreen .

FROM alpine:3.24@sha256:71e9b7bae160ba167fa17414401b94cbcdaf3c32feeab9298bd794a2a0614c35 AS runtime
RUN apk add --no-cache ca-certificates netcat-openbsd
COPY --from=build /out/smokescreen /usr/local/bin/smokescreen
COPY config.yaml /etc/smokescreen/config.yaml
LABEL org.opencontainers.image.source="https://github.com/stripe/smokescreen" \
      org.opencontainers.image.revision="609eb8931420453daf5893509be0b25b21bd9edb" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.description="Pinned Smokescreen source with security fixes: logrus v1.9.3; golang.org/x/net v0.60.0; golang.org/x/text v0.42.0"
USER 65532:65532
EXPOSE 4750
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD nc -z -w 2 127.0.0.1 4750
ENTRYPOINT ["/usr/local/bin/smokescreen", "--config-file", "/etc/smokescreen/config.yaml"]
