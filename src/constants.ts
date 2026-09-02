/** 应用级默认值常量。 */

/** 本地 HTTP 代理默认监听 host。仅监听回环地址，避免暴露到外网。 */
export const DEFAULT_LISTEN_HOST = "127.0.0.1" as const;

/** 本地 HTTP 代理默认监听端口。`0` 表示由 OS 分配一个空闲端口。 */
export const DEFAULT_LISTEN_PORT = 0 as const;

/**
 * 默认空闲 socket 超时时间（毫秒）。
 * 同时作用于「客户端 <-> 本地代理」和「本地代理 <-> 上游 SOCKS」两端，
 * 任一端在此时长内无数据流动即销毁连接，防止连接泄漏。
 */
export const DEFAULT_TIMEOUT_MS = 30_000 as const;

/** SOCKS URL 未写端口时的默认值（1080 是 IANA 注册的 SOCKS 标准端口）。 */
export const DEFAULT_SOCKS_PORT = 1080 as const;

/** HTTPS 默认端口，CONNECT 请求未带端口时使用。 */
export const HTTPS_DEFAULT_PORT = 443 as const;
