/**
 * 本地 HTTP 代理的装配与生命周期管理。
 *
 * 解析上游 SOCKS URL 后，把两条转发路径挂到同一个 http.Server 上：
 * "request" 事件（http:// 目标）走 SocksProxyAgent，"connect" 事件
 * （https:// 目标）走 SocksClient。同时跟踪活跃连接，close() 时统一回收。
 */

import type { Server } from "node:http";
import http from "node:http";
import type { Socket } from "node:net";
import type { SocksProxy } from "socks";
import { SocksProxyAgent } from "socks-proxy-agent";
import { DEFAULT_LISTEN_HOST, DEFAULT_LISTEN_PORT, DEFAULT_TIMEOUT_MS } from "./constants";
import { createConnectHandler } from "./handleConnect";
import { createHttpRequestHandler } from "./handleHttpRequest";
import { parseSocksUrl } from "./parseSocksUrl";
import type { ProxyHandle, ProxyOptions } from "./types";
import { ViaSocksError } from "./ViaSocksError";

/**
 * 启动一个本地 HTTP 代理，把全部流量经上游 SOCKS 代理（含认证）转发。
 *
 * 这是本库的主入口。典型用法（Electron）：
 *
 * ```ts
 * const handle = await createProxy({ proxy: "socks5://user:pass@host:1080" });
 * await ses.setProxy({ proxyRules: handle.url });
 * // ... 使用 session ...
 * await handle.close();
 * ```
 *
 * @param opts - 配置项，详见 {@link ProxyOptions}
 * @returns 代理句柄，含可关闭的 `close()` 方法
 * @throws {ViaSocksError} code=`INVALID_URL` 当 `opts.proxy` 无法解析；
 *   code=`SERVER_BIND_FAILED` 当本地端口监听失败（如端口被占用）。
 */
export async function createProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const parsed = parseSocksUrl(opts.proxy);

  // 两个对象都只含静态配置（代理地址 + 凭据），跨请求共享是安全的；
  // 每个请求的目标地址由各自 handler 内部维护。
  const socksProxy = toSocksProxy(parsed);
  const agent = new SocksProxyAgent(opts.proxy);
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;

  const server = http.createServer();
  server.on("request", createHttpRequestHandler(agent, timeout));
  server.on("connect", createConnectHandler(socksProxy, timeout));

  // 跟踪活跃连接：server.close() 要等所有连接结束才回调，
  // 长命的 CONNECT 隧道不主动销毁的话，close() 会一直挂起。
  const liveSockets = new Set<Socket>();
  server.on("connection", (socket) => {
    liveSockets.add(socket);
    socket.once("close", () => liveSockets.delete(socket));
  });

  await listen(server, opts.host ?? DEFAULT_LISTEN_HOST, opts.port ?? DEFAULT_LISTEN_PORT);

  const address = server.address();
  if (address === null || typeof address === "string") {
    // 理论上不可达（listen 只可能监听 TCP），纯为类型兜底。
    await shutdown(server, liveSockets);
    throw new ViaSocksError("SERVER_BIND_FAILED", "Server ended up on a non-TCP address.");
  }

  let closePromise: Promise<void> | undefined;

  return {
    url: `http://${address.address}:${address.port}`,
    host: address.address,
    port: address.port,
    close: () => {
      // 幂等：缓存首次 close 的 Promise，重复调用直接复用，
      // 避免二次 server.close() 抛 "Server is not running"。
      closePromise ??= shutdown(server, liveSockets);
      return closePromise;
    },
  };
}

/**
 * 便捷封装：只有一个 SOCKS URL 时的一行式调用。
 *
 * 等价于 `createProxy({ proxy: socksUrl })`，其余配置全走默认值。
 *
 * @param socksUrl - 上游 SOCKS URL，如 `socks5://user:pass@host:1080`
 * @throws 与 {@link createProxy} 相同。
 */
export function createProxyFromUrl(socksUrl: string): Promise<ProxyHandle> {
  return createProxy({ proxy: socksUrl });
}

/**
 * 把解析结果映射为 `socks` 库要求的 SocksProxy 结构：
 * socks4 -> 4，socks5/socks5h -> 5；socks4 协议没有密码字段，忽略 password。
 */
function toSocksProxy(parsed: ReturnType<typeof parseSocksUrl>): SocksProxy {
  return {
    host: parsed.host,
    port: parsed.port,
    type: parsed.type === "socks4" ? 4 : 5,
    ...(parsed.userId !== undefined ? { userId: parsed.userId } : {}),
    ...(parsed.type !== "socks4" && parsed.password !== undefined
      ? { password: parsed.password }
      : {}),
  };
}

/**
 * 监听端口，把 EADDRINUSE 等 bind 错误翻译成 SERVER_BIND_FAILED。
 * listen 的错误经 "error" 事件异步到达，所以用一次性监听 + Promise 桥接。
 */
function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // 必须保存同一个函数引用：removeListener 按引用匹配，
    // 新写一个内容相同的箭头函数是删不掉的。
    const onListenError = (err: Error) => {
      reject(
        new ViaSocksError(
          "SERVER_BIND_FAILED",
          `Failed to listen on ${host}:${port} - ${err.message}`,
          err,
        ),
      );
    };
    server.once("error", onListenError);
    server.listen(port, host, () => {
      // 监听成功后摘掉错误桥接，后续 socket 级错误不再进入这个 Promise。
      server.removeListener("error", onListenError);
      resolve();
    });
  });
}

/**
 * 关闭服务器：停止接收新连接，销毁全部活跃连接，等 close 回调。
 */
function shutdown(server: Server, liveSockets: Set<Socket>): Promise<void> {
  return new Promise<void>((resolve) => {
    // 先销毁活跃连接再 close：close() 只在所有连接结束后才回调，
    // 长命隧道不销毁的话这里会永远挂起。
    for (const socket of liveSockets) socket.destroy();
    server.close(() => resolve());
  });
}
