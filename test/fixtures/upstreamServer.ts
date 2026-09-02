/**
 * 测试专用上游服务器（HTTP 与 HTTPS）。
 *
 * 充当「真实目标站点」：e2e 测试里客户端的请求经
 * `本地代理 -> mock SOCKS` 后最终落到这里。
 *
 * 提供的端点：
 * - `GET  /hello`          -> 200，纯文本 "hello from upstream"
 * - `ANY  /echo`           -> 200，JSON 回显 {method, url, headers, body}
 * - `GET  /status/<code>`  -> 指定状态码
 * - `GET  /slow/<ms>`      -> 延迟 ms 后才响应（验证超时与清理逻辑）
 * - `GET  /stream/<bytes>` -> 指定字节数的确定性内容（验证大流量不丢字节）
 *
 * 所有收到的请求都会被记录到 `requests`，供测试断言
 * 「上游实际收到了什么」（方法/路径/头/体），这是验证转发正确性的关键。
 *
 * HTTPS 版本的自签证书用 selfsigned 在内存中按需生成（不落盘、不进仓库），
 * 客户端须以 `rejectUnauthorized: false` 访问。
 */

import type { RequestListener } from "node:http";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import selfsigned from "selfsigned";

/**
 * 测试专用自签证书（CN=localhost，SAN=localhost+127.0.0.1），
 * 用 selfsigned 按需异步生成一次并缓存 Promise：纯内存、跨平台，
 * 仓库无密钥文件。签名算法显式用 sha256（selfsigned 默认 sha1）。
 */
let testCert: Promise<{ key: string; cert: string }> | undefined;

function getTestCert(): Promise<{ key: string; cert: string }> {
  testCert ??= selfsigned
    .generate([{ name: "commonName", value: "localhost" }], {
      algorithm: "sha256",
      extensions: [
        {
          name: "subjectAltName",
          altNames: [
            { type: 2, value: "localhost" },
            { type: 7, ip: "127.0.0.1" },
          ],
        },
      ],
    })
    .then((pems) => ({ key: pems.private, cert: pems.cert }));
  return testCert;
}

/** 记录到的上游请求快照，供断言。 */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface UpstreamHandle {
  port: number;
  /** 形如 `http://127.0.0.1:<port>` 或 `https://...` 的基地址。 */
  baseUrl: string;
  /** 所有收到的请求（按顺序），测试断言用。 */
  requests: RecordedRequest[];
  /** 当前服务器视角的连接数（诊断泄漏用）。 */
  getConnections(): Promise<number>;
  close(): Promise<void>;
}

export interface UpstreamOptions {
  host?: string;
  port?: number;
}

/**
 * 启动 HTTP 上游服务器（端点见文件头注释）。
 */
export function startHttpUpstream(opts: UpstreamOptions = {}): Promise<UpstreamHandle> {
  return startUpstream((handler) => http.createServer(handler), "http", opts);
}

/**
 * 启动 HTTPS 上游服务器（自签证书，端点与 HTTP 版完全一致）。
 * 客户端需 `rejectUnauthorized: false`。
 */
export async function startHttpsUpstream(opts: UpstreamOptions = {}): Promise<UpstreamHandle> {
  const { key, cert } = await getTestCert();
  return startUpstream(
    (handler) => https.createServer({ key, cert }, handler as RequestListener),
    "https",
    opts,
  );
}

/**
 * 共用的服务器装配：注册端点路由、记录请求、监听端口。
 *
 * `listen` 由调用方注入（http 与 https 的 createServer 签名一致，直接传工厂）。
 */
function startUpstream(
  create: (handler: RequestListener) => http.Server | https.Server,
  scheme: "http" | "https",
  opts: UpstreamOptions,
): Promise<UpstreamHandle> {
  const requests: RecordedRequest[] = [];
  // server 在 handler 定义之后才创建，用闭包变量延迟引用，
  // 供路由里的 x-upstream-port 头读取实际监听端口。
  let listeningPort = 0;

  const handler: RequestListener = (req, res) => {
    // 先收集 body（可能分多个 chunk），收完再路由，保证 echo 记录完整。
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: { ...req.headers },
        body,
      });
      route(req, res, body);
    });
  };

  function route(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    const url = req.url ?? "";
    // 路由按 pathname 匹配（query 不参与），记录仍保留完整 url。
    const pathname = url.split("?")[0] ?? url;
    // 每个响应都带上自己的端口，测试用它判断「这条响应到底是谁服务的」，
    // 是并发不串味断言的关键。
    res.setHeader("x-upstream-port", String(listeningPort));

    if (pathname === "/hello") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("hello from upstream");
      return;
    }

    if (pathname === "/echo") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          method: req.method,
          url,
          headers: req.headers,
          body,
        }),
      );
      return;
    }

    const statusMatch = pathname.match(/^\/status\/(\d{3})$/);
    if (statusMatch) {
      const code = Number.parseInt(statusMatch[1], 10);
      res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`status ${code}`);
      return;
    }

    const slowMatch = pathname.match(/^\/slow\/(\d+)$/);
    if (slowMatch) {
      const delay = Number.parseInt(slowMatch[1], 10);
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`slow ${delay}`);
      }, delay);
      return;
    }

    const streamMatch = pathname.match(/^\/stream\/(\d+)$/);
    if (streamMatch) {
      const total = Number.parseInt(streamMatch[1], 10);
      // 确定性内容：循环字节 0-255，客户端可以校验每个位置的字节。
      const payload = Buffer.alloc(total);
      for (let i = 0; i < total; i++) payload[i] = i % 256;
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(total),
      });
      res.end(payload);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }

  const server = create(handler);
  return new Promise<UpstreamHandle>((resolve, reject) => {
    server.once("error", reject);
    const s = server as unknown as http.Server;
    s.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      server.removeListener("error", reject);
      const { address, port } = s.address() as AddressInfo;
      listeningPort = port;
      resolve({
        port,
        baseUrl: `${scheme}://${address}:${port}`,
        get requests() {
          return requests;
        },
        getConnections: () =>
          new Promise<number>((resolve) => s.getConnections((_, n) => resolve(n))),
        close: () =>
          new Promise<void>((resolveClose) => {
            s.closeAllConnections?.();
            s.close(() => resolveClose());
          }),
      });
    });
  });
}
