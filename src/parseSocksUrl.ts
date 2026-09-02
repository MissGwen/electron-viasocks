/**
 * SOCKS 代理 URL 解析器（纯函数）。
 *
 * 基于 WHATWG URL 解析：凭据里的 `@`、`:` 等特殊字符（percent-encode 后）
 * 也能正确切出 userinfo/host/port。URL 的 username/password 保持编码形态，
 * 统一在这里 decodeURIComponent 还原。
 */

import { DEFAULT_SOCKS_PORT } from "./constants";
import type { ParsedSocksUrl, SocksType } from "./types";
import { ViaSocksError } from "./ViaSocksError";

/** 合法的 SOCKS scheme 集合，用于校验 protocol 字段。 */
const KNOWN_SCHEMES = new Set<SocksType>(["socks4", "socks5", "socks5h"]);

/** 合法端口范围（排除 0，因为 0 不是用户可显式指定的有效端口）。 */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * 解析 SOCKS 代理 URL。
 *
 * 接受形如 `socks[4|5|5h]://[user[:pass]@]host[:port]` 的字符串，
 * 返回结构化的 {@link ParsedSocksUrl}。
 *
 * @param raw - 原始 SOCKS URL
 * @returns 解析结果
 * @throws {ViaSocksError} code=`INVALID_URL` 当 URL 无法解析、scheme 不对、
 *   host 缺失或端口越界时抛出。
 *
 * @example
 * ```ts
 * parseSocksUrl("socks5://user:pass@127.0.0.1:1080");
 * // { type: "socks5", host: "127.0.0.1", port: 1080, userId: "user", password: "pass" }
 *
 * parseSocksUrl("socks5://u:p%40ss@host"); // 密码含 @，需 percent-encode
 * // { type: "socks5", host: "host", port: 1080, userId: "u", password: "p@ss" }
 * ```
 */
export function parseSocksUrl(raw: string): ParsedSocksUrl {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ViaSocksError("INVALID_URL", "SOCKS URL is empty or not a string.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new ViaSocksError("INVALID_URL", `Could not parse SOCKS URL: ${raw}`, err);
  }

  // URL.protocol 形如 "socks5:"，去掉末尾冒号得到 scheme。
  const type = url.protocol.replace(/:$/, "") as SocksType;
  if (!KNOWN_SCHEMES.has(type)) {
    throw new ViaSocksError(
      "INVALID_URL",
      `Unsupported proxy scheme "${url.protocol}", expected one of socks4/socks5/socks5h.`,
    );
  }

  const host = parseHost(url.hostname);
  if (!host) {
    throw new ViaSocksError("INVALID_URL", `Missing host in SOCKS URL: ${raw}`);
  }

  const port = parsePort(url.port, raw);

  const userId = decodeField(url.username, "username", raw);
  const password = decodeField(url.password, "password", raw);

  const result: ParsedSocksUrl = { type, host, port };
  if (userId !== undefined) result.userId = userId;
  if (password !== undefined) result.password = password;
  return result;
}

/**
 * 从 `url.hostname` 提取干净的 host。
 *
 * WHATWG URL 对 IPv6 字面量会保留方括号（如 `[::1]`），但下游的
 * `net.connect` / `SocksClient` 期望裸 IPv6 字符串（`::1`），所以这里剥离方括号。
 */
function parseHost(hostnameFromUrl: string): string {
  if (hostnameFromUrl.startsWith("[") && hostnameFromUrl.endsWith("]")) {
    return hostnameFromUrl.slice(1, -1);
  }
  return hostnameFromUrl;
}

/**
 * 解析并校验端口。
 *
 * 空 port 字符串（URL 中省略了 `:port`）按 {@link DEFAULT_SOCKS_PORT} 兜底。
 */
function parsePort(portStr: string, raw: string): number {
  if (portStr === "") return DEFAULT_SOCKS_PORT;
  const n = Number.parseInt(portStr, 10);
  if (Number.isNaN(n) || n < MIN_PORT || n > MAX_PORT) {
    throw new ViaSocksError(
      "INVALID_URL",
      `Invalid port "${portStr}" in SOCKS URL: ${raw} (expected ${MIN_PORT}-${MAX_PORT}).`,
    );
  }
  return n;
}

/**
 * percent-decode 一个 userinfo 字段。
 *
 * WHATWG URL 的 `username`/`password` 不会被自动 decode
 * （例如 `p%40ss` 仍以编码形态返回），所以这里手动 decode。
 *
 * 空字符串视为「未提供」，返回 undefined，避免下游需要区分空串与缺失。
 */
function decodeField(
  value: string,
  field: "username" | "password",
  raw: string,
): string | undefined {
  if (value === "") return undefined;
  try {
    return decodeURIComponent(value);
  } catch (err) {
    throw new ViaSocksError(
      "INVALID_URL",
      `Malformed percent-encoding in ${field} of SOCKS URL: ${raw}`,
      err,
    );
  }
}
