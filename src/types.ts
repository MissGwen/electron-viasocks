/** 本库的公共类型定义。 */

/**
 * 支持的 SOCKS 协议类型。
 *
 * - `socks4`：SOCKS4，仅支持 userId（无密码），DNS 本地解析。
 * - `socks5`：SOCKS5（RFC 1928），支持 user/pass 认证（RFC 1929），DNS 本地解析。
 * - `socks5h`：SOCKS5 + 远程 DNS，域名原样发给上游代理解析，避免本地 DNS 泄漏或被污染。
 */
export type SocksType = "socks4" | "socks5" | "socks5h";

/**
 * 解析 SOCKS URL 后的结构化结果。
 *
 * 由 `parseSocksUrl` 产出，是纯函数式的中间产物，不持有任何 socket 或状态。
 * 后续的 HTTP 转发器与 CONNECT 隧道器都基于它构造各自的连接参数。
 */
export interface ParsedSocksUrl {
  /** SOCKS 协议类型 */
  type: SocksType;
  /** 上游 SOCKS 代理 host（已 percent-decode） */
  host: string;
  /** 上游 SOCKS 代理端口 */
  port: number;
  /** 用户名（已 percent-decode），socks4 时为 userId，无则 undefined */
  userId?: string;
  /** 密码（已 percent-decode），仅 socks5/socks5h 有效，无则 undefined */
  password?: string;
}

/**
 * `createProxy` 的配置项。
 */
export interface ProxyOptions {
  /**
   * 上游 SOCKS 代理 URL，例如 `socks5://user:pass@host:port`。
   * 支持的 scheme：`socks4` / `socks5` / `socks5h`。
   * 凭据中如有特殊字符需 percent-encode（如 `p@ss` -> `p%40ss`）。
   */
  proxy: string;

  /** 本地 HTTP 代理监听 host，默认 `127.0.0.1`。 */
  host?: string;

  /**
   * 本地 HTTP 代理监听端口，默认 `0`（由 OS 分配一个空闲端口）。
   * 显式指定时若被占用会抛 `SERVER_BIND_FAILED`。
   */
  port?: number;

  /**
   * 空闲 socket 超时（毫秒），默认 `30000`。
   * 双向生效：客户端侧与上游侧都会在无数据流动超过此时长后被销毁。
   * 设为 `0` 可禁用超时（不推荐）。
   */
  timeout?: number;
}

/**
 * `createProxy` 成功后返回的代理句柄。
 *
 * 调用方应当：
 *   1. 把 {@link url} 传给 `session.setProxy({ proxyRules })`；
 *   2. 使用完毕后调用 {@link close} 释放本地端口与活跃连接。
 *
 * 不调用 `close()` 不会导致资源立即泄漏——进程退出时端口会被回收，
 * 但长生命周期场景（如 Electron 主进程）下应当显式关闭。
 */
export interface ProxyHandle {
  /** 可直接传给 `session.setProxy({ proxyRules })` 的 HTTP 代理地址。 */
  url: string;

  /** 实际监听的端口（当入参 `port` 为 0 时，这里是 OS 分配的端口）。 */
  port: number;

  /** 实际监听的 host。 */
  host: string;

  /**
   * 关闭本地代理。
   *
   * - 停止接受新连接；
   * - 销毁所有正在进行的活跃连接（已建立的 HTTP 请求 / CONNECT 隧道）；
   * - 释放监听端口。
   *
   * 返回的 Promise 在服务器 `close` 回调触发后 resolve。
   * 重复调用是幂等的，第二次起立即 resolve。
   */
  close(): Promise<void>;
}
