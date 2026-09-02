/**
 * HTTP（非 CONNECT）请求转发器。
 *
 * 用 http.request() + SocksProxyAgent 转发：HTTP 帧的组装与解析全部
 * 交给 Node，本模块只负责校验请求形态、剥离 hop-by-hop 头、把请求和
 * 响应的 body 双向 pipe。每个请求一条独立的上游连接，天然并发安全。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { SocksProxyAgent } from "socks-proxy-agent";
import { stripHopByHopHeaders } from "./headers";
import { ViaSocksError } from "./ViaSocksError";

/**
 * 构造 HTTP 请求处理器（挂到 httpServer 的 "request" 事件）。
 *
 * @param agent - 已配置上游 SOCKS 的 HTTP agent
 * @param timeout - 上游空闲超时（ms），0 表示禁用
 */
export function createHttpRequestHandler(
  agent: SocksProxyAgent,
  timeout: number,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    // 代理请求的 req.url 应是绝对形式（http://host/path）；
    // origin-form（/path）说明客户端没把本机当代理用，无从得知真实目标。
    if (req.url === undefined || !/^https?:\/\//i.test(req.url)) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("electron-viasocks: expected an absolute-form proxy request URL.");
      return;
    }

    // 剥离 hop-by-hop 头（详见 headers.ts），由 Node 重新分帧，避免双重编码。
    const headers = stripHopByHopHeaders(req.headers);

    const upstream = http.request(req.url, {
      agent,
      method: req.method,
      headers,
      ...(timeout > 0 ? { timeout } : {}),
    });

    // 客户端中途断开时立即终止上游请求，别让连接一直挂到超时。
    res.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });

    // 上游空闲超时：以 TIMEOUT 销毁，触发下面的 error 分支回 502。
    if (timeout > 0) {
      upstream.on("timeout", () => {
        upstream.destroy(new ViaSocksError("TIMEOUT", `Upstream idle for over ${timeout}ms.`));
      });
    }

    upstream.on("response", (upstreamRes) => {
      // 响应侧同样剥离 hop-by-hop 头，end-to-end 头原样透传。
      res.writeHead(upstreamRes.statusCode ?? 502, stripHopByHopHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
      // body 传到一半出错时 headers 已发出，无法改回 502，只能销毁连接。
      upstreamRes.on("error", () => res.destroy());
    });

    upstream.on("error", (err) => {
      // 502 响应体带上结构化错误码（AUTH_FAILED / TIMEOUT / ...），方便排障。
      const wrapped = ViaSocksError.wrap(err);
      if (res.headersSent) {
        // 响应已开始：只能销毁，不能改写状态行。
        res.destroy();
      } else {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`electron-viasocks: upstream error [${wrapped.code}] ${wrapped.message}`);
      }
    });

    req.pipe(upstream);
  };
}
