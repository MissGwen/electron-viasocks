/**
 * HTTPS CONNECT 隧道器。
 *
 * CONNECT 的语义是「帮我建一条到 host:port 的 TCP 隧道」，之后的字节流是
 * 端到端的 TLS，代理不解析、只双向 pipe（盲隧道）。
 *
 * 错误处理分两个阶段：建立前失败，客户端还在等应答，可以回 502；
 * 建立后任何一端出错，只能静默销毁双端——往 TLS 流里插 HTTP 明文
 * 会直接破坏协议。
 */

import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { SocksProxy } from "socks";
import { SocksClient } from "socks";
import { HTTPS_DEFAULT_PORT } from "./constants";
import { ViaSocksError } from "./ViaSocksError";

/**
 * 构造 CONNECT 事件处理器（挂到 httpServer 的 "connect" 事件）。
 *
 * @param proxy - 上游 SOCKS 代理的连接信息（host/port/类型/凭据）
 * @param timeout - 建连与隧道空闲的超时（ms），0 表示禁用
 */
export function createConnectHandler(
  proxy: SocksProxy,
  timeout: number,
): (req: IncomingMessage, clientSocket: Socket, head: Buffer) => void {
  return async (req, clientSocket, head) => {
    const destination = parseConnectDestination(req.url);
    if (destination === undefined) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    let upstream: Socket | undefined;
    try {
      const result = await SocksClient.createConnection({
        proxy,
        command: "connect",
        destination,
        ...(timeout > 0 ? { timeout } : {}),
      });
      upstream = result.socket;
    } catch (err) {
      // 建立阶段失败：客户端还在等 CONNECT 应答，回 502。
      const wrapped = ViaSocksError.wrap(err);
      clientSocket.end(
        `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n` +
          `electron-viasocks: CONNECT failed [${wrapped.code}] ${wrapped.message}`,
      );
      return;
    }

    // ---- 隧道已建立，进入盲转发阶段 ----

    // 之后任何一端出错都不再写 HTTP 应答，只静默销毁双端。
    const teardown = () => {
      clientSocket.destroy();
      upstream?.destroy();
    };
    clientSocket.on("error", teardown);
    upstream.on("error", teardown);

    // destroy() 只触发 close 不触发 error：上游的清理必须挂在客户端的
    // close 事件上，否则客户端断开后 SOCKS 隧道会一直挂着。
    clientSocket.on("close", () => {
      upstream?.destroy();
    });

    // socket.setTimeout 只在有 I/O 活动时重置，正好是「空闲」语义：
    // 任一端超过 timeout 无数据流动即销毁双端。
    if (timeout > 0) {
      clientSocket.setTimeout(timeout, teardown);
      upstream.setTimeout(timeout, teardown);
    }

    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) {
      // head 是随 CONNECT 请求同批先到的字节（往往是 TLS ClientHello 的
      // 一截），必须在 pipe 之前先转发，否则客户端握手会卡住。
      upstream.write(head);
    }
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  };
}

/**
 * 解析 CONNECT 请求的目标地址。
 *
 * @param raw - `req.url`，形如 `host:port`（无 scheme、无 path）
 * @returns `{host, port}`；port 缺省按 443（CONNECT 几乎总是 TLS）。
 *   解析失败返回 undefined（由调用方回 400）。
 */
function parseConnectDestination(
  raw: string | undefined,
): { host: string; port: number } | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    // 借 URL 解析器处理 IPv6 方括号、异常端口等边角；
    // http: 前缀只为借它的 authority 解析，不影响 host/port 语义。
    const url = new URL(`http://${raw}`);
    if (!url.hostname) return undefined;
    const port = url.port === "" ? HTTPS_DEFAULT_PORT : Number.parseInt(url.port, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) return undefined;
    // URL 的 hostname 保留 IPv6 方括号（[::1]），SocksClient 要裸地址，剥掉。
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    return { host, port };
  } catch {
    return undefined;
  }
}
