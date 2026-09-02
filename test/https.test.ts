/**
 * HTTPS CONNECT 隧道 e2e 测试（D 组）。
 *
 * 链路全部真实：proxiedHttps 客户端 -> CONNECT 隧道 -> mock SOCKS5 ->
 * HTTPS 上游（自签证书）。TLS 字节流端到端穿过整条隧道。
 *
 * 覆盖：
 * - 隧道建立（200 Connection Established）+ TLS 握手完成
 * - GET/POST 经隧道正确往返
 * - 自定义 headers 经隧道透传
 * - 状态码透传
 * - 并发 CONNECT 隧道互不串味（race regression）
 * - 目标不可达时客户端收到 502 CONNECT rejected
 */

import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProxyHandle } from "../src";
import { createProxy } from "../src";
import { proxiedHttps } from "./fixtures/proxyClient";
import type { MockSocksHandle } from "./fixtures/socks5Server";
import { startMockSocksServer } from "./fixtures/socks5Server";
import type { UpstreamHandle } from "./fixtures/upstreamServer";
import { startHttpsUpstream } from "./fixtures/upstreamServer";

/** 手工发一条 CONNECT，返回首行应答（用于验证隧道协商本身）。 */
function rawConnect(
  proxyUrl: string,
  target: string,
): Promise<{ statusLine: string; socket: net.Socket }> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxy.port), proxy.hostname);
    socket.once("error", reject);
    socket.once("data", (buf: Buffer) => {
      resolve({ statusLine: buf.toString("latin1").split("\r\n")[0] ?? "", socket });
    });
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });
}

async function findDeadPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

describe("HTTPS CONNECT tunneling (e2e)", () => {
  let mock: MockSocksHandle;
  let upstream: UpstreamHandle;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    mock = await startMockSocksServer();
    upstream = await startHttpsUpstream();
    proxy = await createProxy({ proxy: mock.socks5Url() });
  });

  afterAll(async () => {
    await proxy.close();
    await upstream.close();
    await mock.close();
  });

  it("CONNECT handshake replies 200 Connection Established", async () => {
    const { statusLine, socket } = await rawConnect(proxy.url, `127.0.0.1:${upstream.port}`);
    expect(statusLine).toContain("200");
    expect(statusLine.toLowerCase()).toContain("connection established");
    socket.destroy();
  });

  it("GET over the tunnel returns upstream body (TLS works end-to-end)", async () => {
    const res = await proxiedHttps(proxy.url, `${upstream.baseUrl}/hello`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello from upstream");
  });

  it("POST forwards body through the tunnel", async () => {
    const res = await proxiedHttps(proxy.url, `${upstream.baseUrl}/echo`, {
      method: "POST",
      headers: { "x-custom": "tunnel-test" },
      body: "tls-payload",
    });
    expect(res.status).toBe(200);
    const echoed = JSON.parse(res.body);
    expect(echoed.method).toBe("POST");
    expect(echoed.body).toBe("tls-payload");
    expect(echoed.headers["x-custom"]).toBe("tunnel-test");
    // 上游记录同样完整
    const rec = upstream.requests.at(-1);
    expect(rec?.method).toBe("POST");
    expect(rec?.body).toBe("tls-payload");
  });

  it("GET with query and headers round-trips", async () => {
    const res = await proxiedHttps(proxy.url, `${upstream.baseUrl}/echo?q=viasocks`, {
      headers: { "x-another": "42" },
    });
    const echoed = JSON.parse(res.body);
    expect(echoed.url).toBe("/echo?q=viasocks");
    expect(echoed.headers["x-another"]).toBe("42");
  });

  it.each([200, 404, 500])("passes through status %s over TLS", async (code) => {
    const res = await proxiedHttps(proxy.url, `${upstream.baseUrl}/status/${code}`);
    expect(res.status).toBe(code);
  });

  it("CONNECT targets reach the SOCKS server correctly (no crossed destinations)", async () => {
    // 并发 10 条隧道请求，各自带独立 query，断言互不串味。
    const total = 10;
    const results = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        proxiedHttps(proxy.url, `${upstream.baseUrl}/echo?i=${i}`),
      ),
    );
    for (const [i, res] of results.entries()) {
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).url).toBe(`/echo?i=${i}`);
    }
    // mock SOCKS 侧收到的 CONNECT 目标全部指向上游端口
    const targetCount = mock.destinations.filter(
      (d) => d.host === "127.0.0.1" && d.port === upstream.port,
    ).length;
    expect(targetCount).toBeGreaterThanOrEqual(total);
  });

  it("CONNECT to a dead port gets 502 back to the client", async () => {
    const deadPort = await findDeadPort();
    await expect(proxiedHttps(proxy.url, `https://127.0.0.1:${deadPort}/`)).rejects.toThrow(
      /502|CONNECT/i,
    );
  });

  it("CONNECT with invalid port gets 400", async () => {
    // 端口 0 不是合法的可连目标：报文格式合法（能进 connect 事件），
    // 但目标解析失败，代理应回 400。
    const { statusLine, socket } = await rawConnect(proxy.url, "127.0.0.1:0");
    expect(statusLine).toContain("400");
    socket.destroy();
  });
});
