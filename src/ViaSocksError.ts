/**
 * 统一错误类型：让调用方用 `err.code === "AUTH_FAILED"` 这样的结构化
 * 方式判错，而不是去匹配 message 字符串。
 */

/** 错误码字面量联合。 */
export type ViaSocksErrorCode =
  /** SOCKS URL 解析失败：协议不是 socks4/5/5h、缺 host、端口非数字等。 */
  | "INVALID_URL"
  /** 本地 HTTP 代理无法监听到指定 host:port（端口被占用或权限不足）。 */
  | "SERVER_BIND_FAILED"
  /** 无法连接到上游 SOCKS 代理（网络不可达、对方拒绝等）。 */
  | "UPSTREAM_UNREACHABLE"
  /** 上游 SOCKS 拒绝认证（用户名/密码错误，或 socks4 的 userId 不被接受）。 */
  | "AUTH_FAILED"
  /** 某条 socket 在配置的 timeout 内无数据流动，被主动销毁。 */
  | "TIMEOUT"
  /** SOCKS 协议层返回了非成功应答码（如网络不可达、主机不可达等），详见 `message` 与 `cause`。 */
  | "SOCKS_REPLY_FAILED"
  /** 其他未分类错误，作为兜底，`cause` 里携带原始错误。 */
  | "UNKNOWN";

/**
 * `electron-viasocks` 抛出的统一错误类型。
 *
 * @example
 * ```ts
 * try {
 *   const handle = await createProxy({ proxy: "socks5://bad@host:1080" });
 * } catch (e) {
 *   if (e instanceof ViaSocksError && e.code === "INVALID_URL") {
 *     console.error("代理地址写错了：", e.message);
 *   } else {
 *     throw e; // 未知错误，重新抛出
 *   }
 * }
 * ```
 */
export class ViaSocksError extends Error {
  /** 结构化错误码，用于编程判断。 */
  readonly code: ViaSocksErrorCode;

  /** 底层原始错误（如果有），便于排障。 */
  readonly cause?: unknown;

  constructor(code: ViaSocksErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ViaSocksError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }

    // 修复原型链，保证跨 realm（如 vm 模块）等场景下 instanceof 仍能工作。
    Object.setPrototypeOf(this, ViaSocksError.prototype);
  }

  /**
   * 便捷工厂：把任意未知错误包装成 `ViaSocksError`。
   * 若已是 `ViaSocksError` 则原样返回，不重复包装。
   */
  static wrap(err: unknown, code?: ViaSocksErrorCode, message?: string): ViaSocksError {
    if (err instanceof ViaSocksError) return err;
    const msg = message ?? (err instanceof Error ? err.message : String(err));
    return new ViaSocksError(code ?? classifySocksError(err), msg, err);
  }
}

/**
 * 把底层错误（socks 库 / Node socket）粗分类为结构化错误码。
 *
 * socks 库的 Error 没有 code，只能按 message 匹配（匹配串对应其源码
 * constants 里的错误表），因此只用于「选一个最接近的码」。
 */
export function classifySocksError(err: unknown): ViaSocksErrorCode {
  if (err instanceof ViaSocksError) return err.code;

  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();

  // 认证类：RFC 1929 凭据被拒 / 方法协商被拒（客户端不会代理要求的认证方式）。
  if (
    message.includes("authentication failed") ||
    message.includes("no accepted authentication type") ||
    message.includes("no acceptable")
  ) {
    return "AUTH_FAILED";
  }

  // 超时类：socks 库的建连超时 / Node socket 的 idle 超时。
  if (message.includes("timed out") || message.includes("timeout")) return "TIMEOUT";

  // 网络不可达类：errno 码在错误本体或 cause 链上。
  const errno = extractErrno(err);
  if (
    errno === "ECONNREFUSED" ||
    errno === "ENOTFOUND" ||
    errno === "EHOSTUNREACH" ||
    errno === "ENETUNREACH" ||
    errno === "ECONNRESET"
  ) {
    return "UPSTREAM_UNREACHABLE";
  }

  // socks 协议应答拒绝（目标不可达、规则不允许等）。
  if (message.includes("rejected connection")) return "SOCKS_REPLY_FAILED";

  return "UNKNOWN";
}

/** 沿 cause 链找 Node 的 errno 码（如 ECONNREFUSED），最多下钻 3 层。 */
function extractErrno(err: unknown, depth = 0): string | undefined {
  if (depth > 3 || err === null || typeof err !== "object") return undefined;
  const e = err as NodeJS.ErrnoException & { cause?: unknown };
  if (typeof e.code === "string" && e.code.startsWith("E")) return e.code;
  return extractErrno(e.cause, depth + 1);
}
