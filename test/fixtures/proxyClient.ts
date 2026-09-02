/**
 * 测试专用「走代理」HTTP/HTTPS 客户端。
 *
 * 不引入任何第三方 http 客户端依赖，手工实现两种代理请求：
 *
 * 1. HTTP 目标：把绝对形式 URL（`GET http://target/path HTTP/1.1`）直接发给
 *    本地代理端口——这正是浏览器走 HTTP 代理时发出的报文形态；
 *
 * 2. HTTPS 目标：自定义 `https.Agent`，在其 `createConnection` 里完成
 *    `CONNECT host:port` 隧道协商，再把得到的裸 socket 升级为 TLS。
 *    `https.request` 拿到的就是一条已穿过代理的 TLS 连接。
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";

export interface ProxiedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** body 的原始字节（二进制校验用，如 /stream 端点）。 */
  raw: Buffer;
}

export interface ProxiedRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** 毫秒，超时直接 reject（防止用例挂死）。 */
  timeoutMs?: number;
}

/**
 * 经本地 HTTP 代理请求一个 http:// 目标。
 *
 * @param proxyUrl - 本地代理地址（`http://127.0.0.1:<port>`）
 * @param targetUrl - 绝对形式的目标 URL
 */
export function proxiedHttp(
  proxyUrl: string,
  targetUrl: string,
  opts: ProxiedRequestOptions = {},
): Promise<ProxiedResponse> {
  const proxy = new URL(proxyUrl);
  const target = new URL(targetUrl);
  const req = http.request({
    host: proxy.hostname,
    port: Number.parseInt(proxy.port, 10),
    // 绝对形式 path 是「走代理」请求的标志（origin-form 会打不到目标）。
    path: targetUrl,
    method: opts.method ?? "GET",
    headers: {
      // 模拟浏览器走代理的行为：Host 填目标的 authority 而非代理地址，
      // 否则 Node 会自动填上代理的 host:port 并被原样转发到上游。
      host: target.host,
      ...opts.headers,
    },
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  });
  return finishRequest(req, opts);
}

/**
 * 经本地 HTTP 代理（CONNECT 隧道）请求一个 https:// 目标。
 *
 * 自定义 agent 的 `createConnection` 里：TCP 连代理 -> 发 CONNECT ->
 * 收到 200 后把裸 socket 升级为 TLS（测试证书自签，故 rejectUnauthorized:false）。
 */
export function proxiedHttps(
  proxyUrl: string,
  targetUrl: string,
  opts: ProxiedRequestOptions = {},
): Promise<ProxiedResponse> {
  const proxy = new URL(proxyUrl);
  const agent = new TunnelAgent(proxy.hostname, Number.parseInt(proxy.port, 10));
  const target = new URL(targetUrl);
  const req = https.request({
    host: target.hostname,
    port: Number.parseInt(target.port, 10) || 443,
    path: target.pathname + target.search,
    method: opts.method ?? "GET",
    headers: opts.headers ?? {},
    agent,
    rejectUnauthorized: false, // 测试自签证书
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  });
  return finishRequest(req, opts);
}

/** 发出请求并统一收集响应（状态/头/文本体/原始字节）。 */
function finishRequest(
  req: http.ClientRequest,
  opts: ProxiedRequestOptions,
): Promise<ProxiedResponse> {
  return new Promise<ProxiedResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("response", (res) => {
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          raw: Buffer.concat(chunks),
        }),
      );
      res.on("error", reject);
    });
    req.on("timeout", () => {
      req.destroy(new Error(`proxied request timed out after ${opts.timeoutMs}ms`));
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/**
 * 走 CONNECT 隧道的自定义 https.Agent。
 *
 * 每个请求一条独立隧道（不复用连接），符合测试隔离需求。
 */
class TunnelAgent extends https.Agent {
  constructor(
    private readonly proxyHost: string,
    private readonly proxyPort: number,
  ) {
    super();
  }

  /**
   * 签名对齐 http.Agent 基类（callback 可选、返回 stream），
   * 只是不返回同步 socket，全部经 callback 异步交付。
   */
  override createConnection(
    options: http.ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null {
    // 允许只传 err 的简写调用（错误场景没有 socket 可交）。
    const cb = (err: Error | null, stream?: Duplex): void => {
      callback?.(err, stream as Duplex);
    };
    const host = options.host ?? "127.0.0.1";
    const port =
      typeof options.port === "string"
        ? Number.parseInt(options.port, 10) || 443
        : (options.port ?? 443);

    // 第一步：TCP 连到本地代理。
    const socket = net.connect(this.proxyPort, this.proxyHost);
    socket.once("error", (err) => cb(err));

    // 第二步：发 CONNECT，等 200。
    socket.once("data", (buf: Buffer) => {
      const statusLine = buf.toString("latin1").split("\r\n")[0] ?? "";
      if (!/\s200\s/.test(statusLine)) {
        socket.destroy();
        cb(new Error(`CONNECT rejected: ${statusLine}`));
        return;
      }
      // 第三步：在已贯通的裸隧道上做 TLS 握手。
      // servername 只对域名有意义，对 IP 设置会触发 RFC 6066 弃用警告。
      const tlsSocket = tls.connect({
        socket,
        ...(net.isIP(host) === 0 ? { servername: host } : {}),
        rejectUnauthorized: false, // 测试自签证书
      });
      tlsSocket.once("secureConnect", () => cb(null, tlsSocket));
      tlsSocket.once("error", (err) => cb(err));
    });

    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    return null;
  }
}
