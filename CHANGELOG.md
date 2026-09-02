# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-09-02

### Added — `electron-viasocks`, v2 of `electron-session-proxy`

This project is the v2 of
[`electron-session-proxy`](https://github.com/MissGwen/electron-session-proxy),
preserving its core functionality (input a SOCKS URL → output a usable local
HTTP proxy address) while rewriting the implementation from scratch.

- New clean API: `createProxy(opts)` returns a `ProxyHandle` exposing
  `url`, `port`, `host`, and a `close()` method.
- Convenience helper `createProxyFromUrl(socksUrl)`.
- Typed errors via `ViaSocksError` with stable `code` values
  (`INVALID_URL`, `SERVER_BIND_FAILED`, `UPSTREAM_UNREACHABLE`,
  `AUTH_FAILED`, `TIMEOUT`).
- SOCKS URL parsing based on `new URL()`, supporting `socks4`, `socks5`,
  and `socks5h` schemes with proper percent-decoding of credentials.
- HTTP forwarding via `socks-proxy-agent` + `http.request`, correctly
  assembling request lines/headers and parsing responses.
- HTTPS `CONNECT` tunneling via `SocksClient.createConnection` as a blind
  TCP relay.
- OS-assigned listen port via `server.listen(0)` to avoid collisions.
- Configurable idle socket `timeout` (default 30s).
- ESM + CJS dual build via `rslib`, type declarations via Rslib dts.
- Full e2e test suite against a real in-process SOCKS5 mock server
  (RFC 1928 + RFC 1929) and HTTP/HTTPS upstream servers, covering:
  - URL parsing edge cases
  - Lifecycle (bind, close, port allocation)
  - HTTP forwarding (GET/POST/headers/status/streaming/chunked/concurrency)
  - HTTPS CONNECT tunneling (GET/POST/concurrency)
  - Authentication (success, failure, socks4, socks5h)
  - Error handling (client disconnect, timeout, SOCKS error codes)
- `>= 90%` line coverage gate.

### Fixed (vs `electron-session-proxy`)

- Concurrent-request race on shared `socksOptions` destination.
- HTTP targets now work (previously sent a body-only stream upstream and
  double-wrapped the response downstream).
- Port collisions (was random in 50000–59999 range, now OS-assigned).
- Unstoppable local proxy (now exposes `handle.close()`).
- Regex parsing broke on credentials containing `@` or `:`.
- No socket timeouts.
- `tsconfig` now covers the actual library source.

[2.0.0]: https://github.com/MissGwen/electron-viasocks/releases/tag/v2.0.0
