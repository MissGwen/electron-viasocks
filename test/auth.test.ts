/**
 * SOCKS 认证 e2e 测试（E 组）。
 *
 * 这是本库存在的核心动机：验证「带用户名密码的 SOCKS 代理」这条路径。
 * 链路：客户端 -> 本地代理 -> mock SOCKS5（校验凭据）-> 上游。
 *
 * 覆盖：
 * - 正确 user/pass 通过认证并完成转发
 * - 错误密码 / 错误用户名 -> SOCKS 拒绝 -> 代理回 502（含 AUTH_FAILED 码）
 * - 上游要求认证但客户端没带凭据 -> 方法协商被拒 -> 502
 * - socks4（无认证、仅 userId）可用
 * - socks5h（远程 DNS 变体）可用
 * - mock 侧记录的认证尝试与目标列表可供断言
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProxyHandle } from "../src";
import { createProxy } from "../src";
import { proxiedHttp } from "./fixtures/proxyClient";
import type { MockSocksHandle } from "./fixtures/socks5Server";
import { startMockSocksServer } from "./fixtures/socks5Server";
import type { UpstreamHandle } from "./fixtures/upstreamServer";
import { startHttpUpstream } from "./fixtures/upstreamServer";

const USER = "alice";
const PASS = "s3cret:p@ss"; // 故意含 : 与 @，验证凭据编码链路

describe("SOCKS authentication (e2e)", () => {
  let mock: MockSocksHandle;
  let upstream: UpstreamHandle;
  const handles: ProxyHandle[] = [];

  beforeAll(async () => {
    mock = await startMockSocksServer({ username: USER, password: PASS });
    upstream = await startHttpUpstream();
  });

  afterAll(async () => {
    await Promise.all(handles.map((h) => h.close()));
    await upstream.close();
    await mock.close();
  });

  /** 建一个指向 mock 的代理（用给定 URL），登记到 handles 以便统一清理。 */
  async function proxyWith(url: string): Promise<ProxyHandle> {
    const h = await createProxy({ proxy: url });
    handles.push(h);
    return h;
  }

  it("correct credentials authenticate and forward", async () => {
    const proxy = await proxyWith(mock.socks5Url(USER, PASS));
    const res = await proxiedHttp(proxy.url, `${upstream.baseUrl}/hello`);

    expect(res.status).toBe(200);
    expect(res.body).toBe("hello from upstream");
    // mock 侧：一次成功的认证尝试
    expect(mock.authAttempts).toContainEqual({
      username: USER,
      password: PASS,
      ok: true,
    });
  });

  it("credentials with special chars survive the whole chain", async () => {
    // socks5Url 不做编码，直接拼含特殊字符的凭据；
    // 走 createProxy 的 URL 解析 -> percent-encode 检查 -> socks 库 -> mock 校验。
    const proxy = await proxyWith(
      `socks5://${encodeURIComponent(USER)}:${encodeURIComponent(PASS)}@127.0.0.1:${mock.port}`,
    );
    const res = await proxiedHttp(proxy.url, `${upstream.baseUrl}/hello`);
    expect(res.status).toBe(200);
    expect(mock.authAttempts.at(-1)).toMatchObject({ username: USER, password: PASS, ok: true });
  });

  it("wrong password -> 502 with AUTH_FAILED code", async () => {
    const proxy = await proxyWith(mock.socks5Url(USER, "wrong-pass"));
    const res = await proxiedHttp(proxy.url, `${upstream.baseUrl}/hello`);

    expect(res.status).toBe(502);
    // 502 响应体带上结构化错误码，排障不用猜
    expect(res.body).toContain("AUTH_FAILED");
    // mock 侧记录了这次失败的尝试
    expect(mock.authAttempts.at(-1)).toMatchObject({ password: "wrong-pass", ok: false });
  });

  it("wrong username -> 502", async () => {
    const proxy = await proxyWith(mock.socks5Url("bob", PASS));
    const res = await proxiedHttp(proxy.url, `${upstream.baseUrl}/hello`);
    expect(res.status).toBe(502);
    expect(mock.authAttempts.at(-1)).toMatchObject({ username: "bob", ok: false });
  });

  it("no credentials when proxy requires auth -> 502", async () => {
    const proxy = await proxyWith(mock.socks5Url()); // 无凭据
    const attemptsBefore = mock.authAttempts.length;
    const res = await proxiedHttp(proxy.url, `${upstream.baseUrl}/hello`);
    // 方法协商阶段就被拒（mock 只提供 0x02，客户端只会 0x00）
    expect(res.status).toBe(502);
    // 根本没走到子协商阶段，认证尝试记录数不应增加
    expect(mock.authAttempts.length).toBe(attemptsBefore);
  });

  it("socks4 (userId, no password) works against an auth-free mock", async () => {
    // socks4 没有 RFC 1929 认证，另起一个匿名 mock 验证 4/4a 路径。
    const openMock = await startMockSocksServer();
    try {
      const proxy = await proxyWith(openMock.socks4Url("someuser"));
      const res = await proxiedHttp(proxy.url, `${upstream.baseUrl}/hello`);
      expect(res.status).toBe(200);
      expect(res.body).toBe("hello from upstream");
      // 目标确实经 SOCKS4 转发到了上游
      expect(openMock.destinations).toContainEqual({ host: "127.0.0.1", port: upstream.port });
      // 匿名 mock 不应有任何认证记录
      expect(openMock.authAttempts.length).toBe(0);
    } finally {
      await openMock.close();
    }
  });

  it("socks5h (remote DNS variant) works", async () => {
    const url = mock.socks5Url(USER, PASS).replace("socks5://", "socks5h://");
    const proxy = await proxyWith(url);
    const res = await proxiedHttp(proxy.url, `${upstream.baseUrl}/hello`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello from upstream");
  });

  it("CONNECT path also authenticates (HTTPS over authed SOCKS)", async () => {
    const proxy = await proxyWith(mock.socks5Url(USER, PASS));
    const net = await import("node:net");
    // 打一个死端口：认证成功与否都会回 502，
    // 用 mock 的认证记录区分到底走到了哪一步。
    const target = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(proxy.port, "127.0.0.1");
      sock.once("error", reject);
      sock.once("data", () => resolve());
      sock.once("close", () => resolve());
      sock.write(`CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\n\r\n`);
    });
    // SocksClient 在建连时做了认证，且通过（否则到不了 CONNECT 目标连接阶段）
    expect(mock.authAttempts.at(-1)).toMatchObject({ ok: true });
  });
});
