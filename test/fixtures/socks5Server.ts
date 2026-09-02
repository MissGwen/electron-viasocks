/**
 * 测试专用 SOCKS 代理服务器（真实实现，不是 stub）。
 *
 * 实现的协议：
 * - SOCKS5（RFC 1928）：方法协商、CONNECT 命令、IPv4/IPv6/域名三种地址类型
 * - SOCKS5 用户名密码认证（RFC 1929）
 * - SOCKS4 / SOCKS4a：userId（无密码）、IPv4 与域名（4a 的 0.0.0.x + 域名编码）
 *
 * 它是一个「真的能用的代理」：收到 CONNECT 后真实 net.connect 到目标，
 * 成功则双向转发字节，失败则按协议返回对应应答码。这样 e2e 测试里
 * 「客户端 -> 本地代理 -> mock SOCKS -> 上游 server」整条链路都是真实
 * socket、真实字节流。
 *
 * 同时记录所有认证尝试与连接目标，供测试断言（如验证并发请求目标不串味）。
 */

import type { AddressInfo, Socket } from "node:net";
import net from "node:net";

// ---- SOCKS5 协议常量（RFC 1928 / RFC 1929） ----
const SOCKS5_VERSION = 0x05;
/** RFC 1929 子协商版本号。 */
const AUTH_VERSION = 0x01;
const METHOD_NO_AUTH = 0x00;
const METHOD_USERPASS = 0x02;
const METHOD_NONE_ACCEPTABLE = 0xff;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_CONNECTION_REFUSED = 0x05;
const REP_CMD_NOT_SUPPORTED = 0x07;

// ---- SOCKS4 协议常量 ----
const SOCKS4_VERSION = 0x04;
const SOCKS4_GRANTED = 0x5a;
const SOCKS4_REFUSED = 0x5b;

/**
 * 一次 SOCKS5 用户名密码认证尝试的记录。
 * `ok` 表示 mock 是否放行（凭据正确与否）。
 */
export interface AuthAttempt {
  username: string;
  password: string;
  ok: boolean;
}

/** 一次 CONNECT 请求的目标记录。 */
export interface ConnectDestination {
  host: string;
  port: number;
}

export interface MockSocksOptions {
  /** 监听 host，默认 127.0.0.1。 */
  host?: string;
  /** 监听端口，默认 0（OS 分配）。 */
  port?: number;
  /**
   * 配置后要求所有客户端走用户名密码认证（只提供 0x02 方法）。
   * 不配置则只提供 0x00（匿名）方法。
   */
  username?: string;
  password?: string;
}

export interface MockSocksHandle {
  port: number;
  /** 按传入的凭据（若有）拼出 SOCKS URL，方便喂给 createProxy。 */
  socks5Url(username?: string, password?: string): string;
  socks4Url(userId?: string): string;
  /** 所有认证尝试（无论成败），按发生顺序。 */
  authAttempts: AuthAttempt[];
  /** 所有 CONNECT 的目标，按发生顺序。 */
  destinations: ConnectDestination[];
  /** 当前活跃的转发连接数。 */
  activeTunnels: number;
  close(): Promise<void>;
}

/** 每个客户端连接的解析状态。 */
type Stage = "greeting" | "auth" | "request" | "established";

interface ClientSession {
  socket: Socket;
  /** 累积的未消费字节（TCP 不保证消息边界，必须自己攒）。 */
  buffer: Buffer;
  stage: Stage;
  isSocks4: boolean;
  /** 隧道建立后的转发目标连接。 */
  target?: Socket;
  /** activeTunnels 是否已为该 session +1（保证 teardown 只扣一次）。 */
  counted: boolean;
}

/**
 * 启动 mock SOCKS 服务器。
 *
 * @example
 * ```ts
 * const mock = await startMockSocksServer({ username: "u", password: "p" });
 * const handle = await createProxy({ proxy: mock.socks5Url("u", "p") });
 * // ... 断言 mock.destinations、mock.authAttempts ...
 * await handle.close();
 * await mock.close();
 * ```
 */
export function startMockSocksServer(opts: MockSocksOptions = {}): Promise<MockSocksHandle> {
  const requiresAuth = opts.username !== undefined;
  const authAttempts: AuthAttempt[] = [];
  const destinations: ConnectDestination[] = [];
  const sessions = new Set<ClientSession>();
  let activeTunnels = 0;

  const server = net.createServer((clientSocket) => {
    const session: ClientSession = {
      socket: clientSocket,
      buffer: Buffer.alloc(0),
      stage: "greeting",
      isSocks4: false,
      counted: false,
    };
    sessions.add(session);

    clientSocket.on("data", (chunk: Buffer) => {
      session.buffer = Buffer.concat([session.buffer, chunk]);
      // 一个 chunk 里可能包含协商+请求多段报文，循环消费到不够一字段为止。
      let consumed = true;
      while (consumed && session.stage !== "established") {
        consumed =
          session.stage === "greeting"
            ? handleGreeting(session, requiresAuth)
            : session.stage === "auth"
              ? handleAuth(session, authAttempts, opts)
              : session.stage === "request"
                ? handleRequest(session, destinations)
                : false;
      }
    });

    // 客户端（代理侧）断开：除了删记录，还必须拆掉已建立的目标连接，
    // 否则目标侧 socket 挂着、activeTunnels 计数泄漏（真实代理也是这么做的）。
    clientSocket.on("close", () => {
      sessions.delete(session);
      session.target?.destroy();
    });
    clientSocket.on("error", () => clientSocket.destroy());
  });

  return new Promise<MockSocksHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      server.removeListener("error", reject);
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        socks5Url: (u, p) => `socks5://${u !== undefined ? `${u}:${p}@` : ""}127.0.0.1:${port}`,
        socks4Url: (u) => `socks4://${u !== undefined ? `${u}@` : ""}127.0.0.1:${port}`,
        get authAttempts() {
          return authAttempts;
        },
        get destinations() {
          return destinations;
        },
        get activeTunnels() {
          return activeTunnels;
        },
        close: () =>
          new Promise<void>((resolveClose) => {
            for (const s of sessions) s.socket.destroy();
            server.close(() => resolveClose());
          }),
      });
    });
  });

  // ---- 以下为各阶段的状态机处理，返回是否消费了报文 ----

  /** 阶段 1：方法协商（SOCKS5）或分流到 SOCKS4/4a 单报文路径。 */
  function handleGreeting(session: ClientSession, requiresAuthFlag: boolean): boolean {
    const b = session.buffer;
    if (b.length < 1) return false;

    // SOCKS4/4a 是单报文协议（没有协商阶段），按首字节分流。
    if (b[0] === SOCKS4_VERSION) {
      session.isSocks4 = true;
      session.stage = "request";
      return true; // 流转到 handleRequest 里的 socks4 分支继续解析
    }
    if (b[0] !== SOCKS5_VERSION) {
      session.socket.destroy();
      return false;
    }

    if (b.length < 2) return false;
    const nmethods = b[1];
    if (b.length < 2 + nmethods) return false;
    const methods = b.subarray(2, 2 + nmethods);
    session.buffer = b.subarray(2 + nmethods);

    if (requiresAuthFlag) {
      if (methods.includes(METHOD_USERPASS)) {
        session.socket.write(Buffer.from([SOCKS5_VERSION, METHOD_USERPASS]));
        session.stage = "auth";
      } else {
        // 客户端不会用户名密码认证：按协议回「没有可接受方法」后断开。
        session.socket.write(Buffer.from([SOCKS5_VERSION, METHOD_NONE_ACCEPTABLE]));
        session.socket.destroy();
      }
      return true;
    }
    if (methods.includes(METHOD_NO_AUTH)) {
      session.socket.write(Buffer.from([SOCKS5_VERSION, METHOD_NO_AUTH]));
      session.stage = "request";
      return true;
    }
    session.socket.write(Buffer.from([SOCKS5_VERSION, METHOD_NONE_ACCEPTABLE]));
    session.socket.destroy();
    return true;
  }

  /** 阶段 2（仅当协商出 0x02）：RFC 1929 用户名密码子协商。 */
  function handleAuth(
    session: ClientSession,
    attempts: AuthAttempt[],
    options: MockSocksOptions,
  ): boolean {
    const b = session.buffer;
    if (b.length < 2) return false;
    if (b[0] !== AUTH_VERSION) {
      session.socket.destroy();
      return false;
    }
    const ulen = b[1];
    if (b.length < 2 + ulen + 1) return false;
    const plen = b[2 + ulen];
    if (b.length < 2 + ulen + 1 + plen) return false;

    const username = b.subarray(2, 2 + ulen).toString("utf8");
    const password = b.subarray(3 + ulen, 3 + ulen + plen).toString("utf8");
    session.buffer = b.subarray(3 + ulen + plen);

    const ok = username === (options.username ?? "") && password === (options.password ?? "");
    attempts.push({ username, password, ok });

    session.socket.write(Buffer.from([AUTH_VERSION, ok ? 0x00 : 0x01]));
    if (ok) {
      session.stage = "request";
    } else {
      session.socket.destroy();
    }
    return true;
  }

  /** 阶段 3：CONNECT 命令。SOCKS4/4a 也走这里（按 isSocks4 分流）。 */
  function handleRequest(session: ClientSession, dests: ConnectDestination[]): boolean {
    return session.isSocks4
      ? handleSocks4Request(session, dests)
      : handleSocks5Request(session, dests);
  }

  function handleSocks5Request(session: ClientSession, dests: ConnectDestination[]): boolean {
    const b = session.buffer;
    if (b.length < 4) return false;
    const cmd = b[1];
    const atyp = b[3];

    let host: string;
    let addrLen: number;
    if (atyp === ATYP_IPV4) {
      addrLen = 4;
      if (b.length < 4 + 4 + 2) return false;
      host = Array.from(b.subarray(4, 8)).join(".");
    } else if (atyp === ATYP_DOMAIN) {
      if (b.length < 5) return false;
      const dlen = b[4];
      addrLen = 1 + dlen;
      if (b.length < 4 + 1 + dlen + 2) return false;
      host = b.subarray(5, 5 + dlen).toString("utf8");
    } else if (atyp === ATYP_IPV6) {
      addrLen = 16;
      if (b.length < 4 + 16 + 2) return false;
      host = formatIpv6(b.subarray(4, 20));
    } else {
      replySocks5(session.socket, REP_GENERAL_FAILURE);
      session.socket.destroy();
      return true;
    }

    const port = b.readUInt16BE(4 + addrLen);
    session.buffer = b.subarray(4 + addrLen + 2);

    if (cmd !== CMD_CONNECT) {
      replySocks5(session.socket, REP_CMD_NOT_SUPPORTED);
      session.socket.destroy();
      return true;
    }

    connectTarget(session, host, port, dests, () => replySocks5(session.socket, REP_SUCCESS));
    return true;
  }

  function handleSocks4Request(session: ClientSession, dests: ConnectDestination[]): boolean {
    const b = session.buffer;
    // [VN][CD][DSTPORT 2][DSTIP 4][USERID\0]...[/4a: DOMAIN\0]
    if (b.length < 8) return false;
    const cmd = b[1];
    const dport = b.readUInt16BE(2);
    const dip = b.subarray(4, 8);

    // userId 以 \0 结尾，从 offset 8 开始找。
    const userIdEnd = b.indexOf(0, 8);
    if (userIdEnd === -1) return false;

    let host: string;
    let consumedEnd: number;
    const is4aDomain = dip[0] === 0 && dip[1] === 0 && dip[2] === 0 && dip[3] !== 0;
    if (is4aDomain) {
      // SOCKS4a：域名跟在 userId\0 之后，同样以 \0 结尾。
      const domainEnd = b.indexOf(0, userIdEnd + 1);
      if (domainEnd === -1) return false;
      host = b.subarray(userIdEnd + 1, domainEnd).toString("utf8");
      consumedEnd = domainEnd + 1;
    } else {
      host = Array.from(dip).join(".");
      consumedEnd = userIdEnd + 1;
    }
    session.buffer = b.subarray(consumedEnd);

    if (cmd !== CMD_CONNECT) {
      replySocks4(session.socket, false);
      session.socket.destroy();
      return true;
    }

    connectTarget(session, host, dport, dests, () => replySocks4(session.socket, true));
    return true;
  }

  /** 真实连到目标：成功回 success 回调并双向 pipe；失败回对应错误码。 */
  function connectTarget(
    session: ClientSession,
    host: string,
    port: number,
    dests: ConnectDestination[],
    onSuccess: () => void,
  ): void {
    dests.push({ host, port });
    const target = net.connect(port, host);
    target.on("connect", () => {
      activeTunnels++;
      session.counted = true;
      session.stage = "established";
      session.target = target;
      onSuccess();
      target.pipe(session.socket);
      session.socket.pipe(target);
    });
    // 目标侧断开：扣一次计数并拆掉客户端连接。
    // close/error 都可能触发，用 counted 标志保证只扣一次（幂等）。
    const onTargetGone = () => {
      if (session.counted) {
        activeTunnels--;
        session.counted = false;
      }
      session.socket.destroy();
    };
    target.on("close", onTargetGone);
    target.on("error", (err: NodeJS.ErrnoException) => {
      // 连接目标失败（尚未 established）：先按协议回错误码，再拆连接。
      if (session.stage !== "established") {
        const rep = err.code === "ECONNREFUSED" ? REP_CONNECTION_REFUSED : REP_GENERAL_FAILURE;
        if (session.isSocks4) replySocks4(session.socket, false);
        else replySocks5(session.socket, rep);
      }
      onTargetGone();
    });
  }

  function replySocks5(socket: Socket, rep: number): void {
    // [VER][REP][RSV][ATYP=IPv4][BND.ADDR=0.0.0.0][BND.PORT=0]
    socket.write(Buffer.from([SOCKS5_VERSION, rep, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]));
  }

  function replySocks4(socket: Socket, granted: boolean): void {
    // [VN=0][CD][DSTPORT][DSTIP]，全 0 也合法（客户端只看 CD）。
    socket.write(Buffer.from([0x00, granted ? SOCKS4_GRANTED : SOCKS4_REFUSED, 0, 0, 0, 0, 0, 0]));
  }

  /** 把 16 字节转成标准 IPv6 字符串（用 Node 自己的格式化，避免手写缩写规则）。 */
  function formatIpv6(bytes: Buffer): string {
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      groups.push(bytes.readUInt16BE(i).toString(16));
    }
    return groups.join(":");
  }
}
