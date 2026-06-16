FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mint-pairing-broker .

FROM alpine:3.20
RUN addgroup -S broker && adduser -S broker -G broker && mkdir -p /data && chown broker:broker /data
USER broker
WORKDIR /app
COPY --from=build /out/mint-pairing-broker /app/mint-pairing-broker
ENV ADDR=:8080
ENV BROKER_DB_PATH=/data/mint-pairing.db
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/app/mint-pairing-broker"]
