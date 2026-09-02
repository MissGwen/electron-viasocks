/**
 * HTTP 头处理工具。
 *
 * RFC 7230 §6.1：Connection、Keep-Alive、Transfer-Encoding、TE、Trailer、
 * Upgrade、Proxy-* 等头是 hop-by-hop 的，只对单跳连接有意义，代理转发时
 * 必须剥掉——否则 Transfer-Encoding 会和 Node 自动分帧冲突，Proxy-* 头
 * 会泄漏给源站。
 *
 * Connection 头的值本身是头名列表（如 `keep-alive, upgrade`），
 * 列表里的头同样 hop-by-hop，也要一并剥离。
 */

import type { IncomingHttpHeaders } from "node:http";

/** RFC 7230 §6.1 点名的 hop-by-hop 头（小写）。 */
const WELL_KNOWN_HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * 剥离所有 hop-by-hop 头，返回一个干净的新头对象（不修改入参）。
 *
 * 处理规则：
 * 1. 删除 RFC 点名的 hop-by-hop 头（见 {@link WELL_KNOWN_HOP_BY_HOP}）；
 * 2. 解析 `Connection` 头的值，删除其中列举的所有头名；
 * 3. 保留其余一切头（含 `Content-Length`、`Content-Type`、`Host` 等 end-to-end 头）。
 *
 * @param headers - 原始头对象（来自 `IncomingMessage.headers` 或
 *   `ServerResponse` 即将写出的头）
 * @returns 剥离后的新头对象
 */
export function stripHopByHopHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  // 先收集 Connection 头里列举的附加头名（可能有一个或多个值，逗号分隔）。
  const listed = new Set<string>();
  const connectionValues = headers.connection;
  if (connectionValues !== undefined) {
    const values = Array.isArray(connectionValues) ? connectionValues : [connectionValues];
    for (const v of values) {
      for (const name of v.split(",")) {
        const trimmed = name.trim().toLowerCase();
        if (trimmed.length > 0) listed.add(trimmed);
      }
    }
  }

  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (WELL_KNOWN_HOP_BY_HOP.has(lower) || listed.has(lower)) continue;
    result[lower] = value;
  }
  return result;
}
