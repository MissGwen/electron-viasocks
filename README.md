# electron-viasocks

> Bridge a SOCKS4/5 proxy (with username/password authentication) into a local
> HTTP proxy that Electron's `session.setProxy()` can consume.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **v2 of [`electron-session-proxy`](https://github.com/MissGwen/electron-session-proxy)** —
> same mission, rebuilt from scratch: correct, test-verified, and fully
> manageable. See [what changed in v2](#from-v1-electron-session-proxy-to-v2).

## Why

Electron's `session.setProxy({ proxyRules })` **does not support SOCKS proxies
that require username/password authentication**. A URL like
`socks5://user:pass@host:1080` silently fails to authenticate, so the proxy is
effectively unusable from an Electron session.

`electron-viasocks` solves this by spinning up a **tiny local HTTP proxy** that
performs the SOCKS authentication itself, then hands you a plain
`http://127.0.0.1:<port>` URL that Electron happily consumes.

```ts
// Before — authentication silently fails ❌
await ses.setProxy({ proxyRules: "socks5://user:pass@127.0.0.1:1080" });

// After — authentication works ✅
import { createProxy } from "electron-viasocks";
const handle = await createProxy({ proxy: "socks5://user:pass@127.0.0.1:1080" });
await ses.setProxy({ proxyRules: handle.url });
// ... use the session ...
await handle.close();
```

## From v1 (`electron-session-proxy`) to v2

[v1 — `electron-session-proxy`](https://github.com/MissGwen/electron-session-proxy)
solved a real pain: Electron's `session.setProxy()` cannot authenticate against
SOCKS proxies that require a username/password. But its implementation shipped
correctness and lifecycle bugs. v2 keeps the one-line mission — *SOCKS URL in,
local HTTP proxy URL out* — and fixes the rest:

| # | v1 problem                                                  | v2                                            |
| - | ----------------------------------------------------------- | --------------------------------------------- |
| 1 | Shared mutable `socksOptions` raced concurrent requests     | Per-request connections, no shared state      |
| 2 | HTTP targets broken (body-only stream, no request framing)  | Real `http.request` via `SocksProxyAgent`     |
| 3 | Random port in 50000–59999 could collide                    | `listen(0)` — the OS assigns a free port      |
| 4 | No way to stop the proxy once started                       | `handle.close()`                              |
| 5 | Regex parsing broke on `@`/`:` in credentials               | `new URL()` + percent-decoding                |
| 6 | No socket timeouts — hung sockets leaked forever            | Configurable `timeout` (default 30s)          |

Beyond fixes, v2 adds typed errors (`ViaSocksError`), SOCKS4a/`socks5h`
support, a full e2e test suite (80+ cases against an RFC 1928/1929 SOCKS5
mock), and dual ESM/CJS builds.

### Migrating from v1

```ts
// v1 — electron-session-proxy
import { sockProxyRules } from "electron-session-proxy";
const url = await sockProxyRules("socks5://user:pass@127.0.0.1:1080");
await ses.setProxy({ proxyRules: url });
// ...and no way to ever stop the proxy

// v2 — electron-viasocks
import { createProxyFromUrl } from "electron-viasocks";
const handle = await createProxyFromUrl("socks5://user:pass@127.0.0.1:1080");
await ses.setProxy({ proxyRules: handle.url });
// ...later
await handle.close();
```

## Install

```sh
npm install electron-viasocks
# or
pnpm add electron-viasocks
# or
yarn add electron-viasocks
```

> Requires Node `>=18.0.0`. Designed for Electron but works for any HTTP
> client that honors an HTTP proxy.

## Quick start

```ts
import { session } from "electron";
import { createProxy } from "electron-viasocks";

const ses = session.fromPartition("persist:github");

const handle = await createProxy({
  proxy: "socks5://user:pass@127.0.0.1:1080",
  // host: "127.0.0.1",  // local listen host, default 127.0.0.1
  // port: 0,            // local listen port, default 0 = OS picks a free one
  // timeout: 30_000,    // idle socket timeout in ms, default 30000
});

await ses.setProxy({ proxyRules: handle.url });

// later, when you no longer need the proxy
await handle.close();
```

A one-shot helper is also provided for the common case:

```ts
import { createProxyFromUrl } from "electron-viasocks";
const handle = await createProxyFromUrl("socks5://user:pass@127.0.0.1:1080");
```

## API

### `createProxy(opts): Promise<ProxyHandle>`

Starts a local HTTP proxy that tunnels every request through the given
upstream SOCKS proxy (with authentication).

#### `ProxyOptions`

| Field     | Type     | Default     | Description                                                          |
| --------- | -------- | ----------- | -------------------------------------------------------------------- |
| `proxy`   | `string` | — (required) | Upstream SOCKS URL, e.g. `socks5://user:pass@host:port`             |
| `host`    | `string` | `127.0.0.1` | Local listen host                                                    |
| `port`    | `number` | `0`         | Local listen port; `0` lets the OS pick a free one                   |
| `timeout` | `number` | `30000`     | Idle socket timeout in ms (both client- and upstream-side)          |

Supported SOCKS URL schemes:

- `socks4://[user@]host:port`
- `socks5://[user:pass@]host:port`
- `socks5h://[user:pass@]host:port` (remote DNS resolution)

#### `ProxyHandle`

| Field   | Type                       | Description                                         |
| ------- | ------------------------- | --------------------------------------------------- |
| `url`   | `string`                  | `http://<host>:<port>` — pass to `setProxy`         |
| `port`  | `number`                  | The actual listening port                           |
| `host`  | `string`                  | The listening host                                  |
| `close` | `() => Promise<void>`     | Stops the local proxy and destroys active sockets   |

#### Throws

- `ViaSocksError` with code `INVALID_URL` — the `proxy` URL could not be parsed.
- `ViaSocksError` with code `SERVER_BIND_FAILED` — could not listen on the requested port.

### `createProxyFromUrl(socksUrl): Promise<ProxyHandle>`

Shorthand for `createProxy({ proxy: socksUrl })`.

### `ViaSocksError`

A typed `Error` subclass with a `code` field:

| Code                    | Meaning                                            |
| ----------------------- | -------------------------------------------------- |
| `INVALID_URL`           | The SOCKS URL is malformed                         |
| `SERVER_BIND_FAILED`    | The local HTTP proxy could not bind its port       |
| `UPSTREAM_UNREACHABLE`  | Could not connect to the upstream SOCKS server     |
| `AUTH_FAILED`           | SOCKS username/password authentication failed      |
| `TIMEOUT`               | A socket timed out                                 |

## How it works

The local HTTP proxy handles two kinds of traffic:

```
                ┌────────────────────────────────────────────────────────┐
                │              electron-viasocks (local)                  │
  Electron ───► │  http://127.0.0.1:<port>                              │
   (Chromium)   │                                                        │
                │  ┌─────────────────────┐   ┌────────────────────────┐  │
                │  │  HTTP request path   │   │  HTTPS CONNECT path    │  │
                │  │  http.request(...)   │   │  SocksClient.create    │  │
                │  │  + SocksProxyAgent   │   │  Connection(...)       │  │
                │  │  → assembles &      │   │  → blind TCP tunnel     │  │
                │  │    parses HTTP      │   │    (TLS bytes passed    │  │
                │  │    frames           │   │     through verbatim)  │  │
                │  └──────────┬──────────┘   └───────────┬────────────┘  │
                │             │                          │               │
                └─────────────┼──────────────────────────┼───────────────┘
                              │                          │
                              ▼                          ▼
                     ┌──────────────────────────────────────┐
                     │   Upstream SOCKS4/5 proxy            │
                     │   (authenticates user:pass here)     │
                     └─────────────────┬────────────────────┘
                                       │
                                       ▼
                             ┌──────────────────┐
                             │   Target host    │
                             └──────────────────┘
```

- **HTTP target**: a real HTTP request is assembled by Node's `http` module
  and routed through a `SocksProxyAgent`, so request lines, headers, and
  bodies are all correctly formed.
- **HTTPS target**: the `CONNECT` method is intercepted, a SOCKS connection
  is opened to the target, and the rest is a blind TCP tunnel carrying TLS
  bytes verbatim.

## Attribution

Powered by the [socks](https://github.com/JoshGlazebrook/socks) and
[socks-proxy-agent](https://github.com/TooTallNate/proxy-agents) projects.
v1 lives on at
[`electron-session-proxy`](https://github.com/MissGwen/electron-session-proxy).

## License

[MIT](LICENSE) © MissGwen
