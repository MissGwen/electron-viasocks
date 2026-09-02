/**
 * HTTP 转发 e2e 测试（C 组）。
 *
 * 链路全部真实：proxiedHttp 客户端 -> 本地代理 -> mock SOCKS5 -> 上游 HTTP server。
 *
 * 覆盖：
 * - GET/POST/PUT/DELETE 基本转发
 * - 请求 headers 透传 + hop-by-hop 头剥离
 * - 响应状态码/headers/body 正确返回
 * - 大流量（256KB）字节级校验
 * - chunked 传输（echo 端点默认 chunked）
 * - 并发竞态：两个上游 A/B，20 个并发请求交替打，断言每条响应
 *   都由「正确的上游」服务（x-upstream-port 头 + 上游请求记录双重验证）
 * - 目标不可达 -> 502
 */

import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProxyHandle } from "../src";
import { createProxy } from "../src";
import { proxiedHttp } from "./fixtures/proxyClient";
import type { MockSocksHandle } from "./fixtures/socks5Server";
import { startMockSocksServer } from "./fixtures/socks5Server";
import type { UpstreamHandle } from "./fixtures/upstreamServer";
import { startHttpUpstream } from "./fixtures/upstreamServer";

/** 拿一个「确定没人监听」的端口：先占住拿到端口号再立刻释放。 */
async function findDeadPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

describe("HTTP forwarding (e2e)", () => {
  let mock: MockSocksHandle;
  let upstreamA: UpstreamHandle;
  let upstreamB: UpstreamHandle;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    mock = await startMockSocksServer();
    upstreamA = await startHttpUpstream();
    upstreamB = await startHttpUpstream();
    proxy = await createProxy({ proxy: mock.socks5Url() });
  });

  afterAll(async () => {
    await proxy.close();
    await upstreamA.close();
    await upstreamB.close();
    await mock.close();
  });

  it("GET /hello returns the upstream body verbatim", async () => {
    const res = await proxiedHttp(proxy.url, `${upstreamA.baseUrl}/hello`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello from upstream");
    // 响应头确实透传回来了
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["x-upstream-port"]).toBe(String(upstreamA.port));
  });

  it("GET /echo with query and custom headers forwards everything", async () => {
    const res = await proxiedHttp(proxy.url, `${upstreamA.baseUrl}/echo?x=1&y=hello`, {
      headers: { "x-custom-token": "abc123" },
    });
    expect(res.status).toBe(200);
    const echoed = JSON.parse(res.body);
    expect(echoed.method).toBe("GET");
    expect(echoed.url).toBe("/echo?x=1&y=hello");
    // 上游真实收到的头（经 echo 回显）包含自定义头
    expect(echoed.headers["x-custom-token"]).toBe("abc123");
    // Host 头应指向上游（而不是本地代理）
    expect(echoed.headers.host).toBe(`127.0.0.1:${upstreamA.port}`);
  });

  it("POST forwards the request body", async () => {
    const res = await proxiedHttp(proxy.url, `${upstreamA.baseUrl}/echo`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello body",
    });
    expect(res.status).toBe(200);
    const echoed = JSON.parse(res.body);
    expect(echoed.method).toBe("POST");
    expect(echoed.body).toBe("hello body");
    // 上游侧的记录同样完整
    const rec = upstreamA.requests.at(-1);
    expect(rec?.method).toBe("POST");
    expect(rec?.body).toBe("hello body");
  });

  it.each(["PUT", "DELETE"])("%s method forwards correctly", async (method) => {
    const res = await proxiedHttp(proxy.url, `${upstreamA.baseUrl}/echo`, {
      method,
      body: method === "PUT" ? "put-payload" : undefined,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).method).toBe(method);
  });

  it.each([200, 301, 404, 500])("passes through status %s", async (code) => {
    const res = await proxiedHttp(proxy.url, `${upstreamA.baseUrl}/status/${code}`);
    expect(res.status).toBe(code);
    expect(res.body).toBe(`status ${code}`);
  });

  it("streams a 256KB payload byte-for-byte", async () => {
    const size = 256 * 1024;
    const res = await proxiedHttp(proxy.url, `${upstreamA.baseUrl}/stream/${size}`);
    expect(res.status).toBe(200);
    expect(Number(res.headers["content-length"])).toBe(size);
    // 字节级校验：内容是 i % 256 的确定性循环
    expect(res.raw.length).toBe(size);
    for (let i = 0; i < size; i++) {
      if (res.raw[i] !== i % 256) {
        expect.fail(`byte mismatch at ${i}: ${res.raw[i]} !== ${i % 256}`);
      }
    }
  });

  it("handles chunked transfer-encoding (echo without content-length)", async () => {
    const res = await proxiedHttp(proxy.url, `${upstreamA.baseUrl}/echo`, {
      method: "POST",
      body: "chunk-me",
    });
    // 上游 echo 响应是 chunked（fixture 未设 content-length），
    // 如果代理端 Transfer-Encoding 处理有误，这里会解不出 body。
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).body).toBe("chunk-me");
    expect(res.headers["transfer-encoding"]).toBe("chunked");
  });

  it("strips hop-by-hop headers before forwarding upstream", async () => {
    await proxiedHttp(proxy.url, `${upstreamA.baseUrl}/echo`, {
      headers: {
        // 模拟浏览器走代理时典型的 hop-by-hop 头
        "proxy-connection": "keep-alive",
        connection: "x-secret-hop-header",
        "x-secret-hop-header": "should-not-appear",
        "x-real-header": "kept",
      },
    });
    const rec = upstreamA.requests.at(-1);
    expect(rec).toBeDefined();

    // 客户端原始的 Connection 值不得泄漏到上游：我们转发用的 http.request
    // 会按自身连接语义补一个合法的 Connection: close（这是代理作为客户端
    // 的正当 hop-by-hop 头，不是原始值泄漏），但绝不能是 x-secret-hop-header。
    expect(rec?.headers.connection).not.toBe("x-secret-hop-header");
    // Proxy-Connection 与 Connection 列举的头都不该到上游
    expect(rec?.headers["proxy-connection"]).toBeUndefined();
    expect(rec?.headers["x-secret-hop-header"]).toBeUndefined();
    // end-to-end 头保留
    expect(rec?.headers["x-real-header"]).toBe("kept");
  });

  it("concurrent requests to two upstreams never cross (race regression)", async () => {
    // 并发安全回归：目标地址一旦被并发请求互相覆盖，交替请求立刻串味。
    // 两个可区分的上游 + 20 个并发交替请求，一旦串味马上能抓到。
    const total = 20;
    const results = await Promise.all(
      Array.from({ length: total }, (_, i) => {
        const target = i % 2 === 0 ? upstreamA : upstreamB;
        return proxiedHttp(proxy.url, `${target.baseUrl}/echo?i=${i}`);
      }),
    );

    for (const [i, res] of results.entries()) {
      const intended = i % 2 === 0 ? upstreamA : upstreamB;
      // 双重验证：响应头说明谁服务的，echo 内容说明请求是谁的
      expect(res.headers["x-upstream-port"]).toBe(String(intended.port));
      expect(JSON.parse(res.body).url).toBe(`/echo?i=${i}`);
    }

    // 上游侧记录同样无串味：A 只收到偶数 i，B 只收到奇数 i
    const urlsA = upstreamA.requests.slice(-10).map((r) => r.url);
    const urlsB = upstreamB.requests.slice(-10).map((r) => r.url);
    expect(urlsA).toEqual(Array.from({ length: 10 }, (_, k) => `/echo?i=${k * 2}`));
    expect(urlsB).toEqual(Array.from({ length: 10 }, (_, k) => `/echo?i=${k * 2 + 1}`));
  });

  it("returns 502 when the target host is unreachable", async () => {
    const deadPort = await findDeadPort();
    const res = await proxiedHttp(proxy.url, `http://127.0.0.1:${deadPort}/hello`);
    // mock SOCKS 连不上目标 -> socks 库报错 -> 我们的 handler 回 502
    expect(res.status).toBe(502);
    expect(res.body).toContain("electron-viasocks");
  });

  it("rejects origin-form requests (not using us as a proxy) with 400", async () => {
    // 直接把 /path 当目标发过来：客户端没有按代理协议用绝对形式 URL，
    // 我们无法得知真实目标，应当 400 而不是乱猜。
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxy.port,
          path: "/not-a-proxy-request",
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain("absolute-form");
  });

  it("CONNECT tunnel forwards data pipelined in the same flight (head buffer)", async () => {
    // 一次 write 同时发出 CONNECT 与完整的 HTTP 请求：CONNECT 应答后，
    // 先到的请求字节以 head 形态到达代理，必须先于 pipe 转发出去，
    // 否则数据丢失（客户端表现为请求卡死）。
    const text = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxy.port, "127.0.0.1");
      const all: Buffer[] = [];
      socket.once("error", reject);
      socket.on("data", (b: Buffer) => all.push(b));
      socket.on("close", () => resolve(Buffer.concat(all).toString("utf8")));
      socket.write(
        `CONNECT 127.0.0.1:${upstreamA.port} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamA.port}\r\n\r\n` +
          `GET /hello HTTP/1.1\r\nHost: 127.0.0.1:${upstreamA.port}\r\nConnection: close\r\n\r\n`,
      );
      setTimeout(() => {
        socket.destroy();
        reject(new Error("CONNECT pipelined test timed out"));
      }, 5000);
    });
    expect(text).toContain("200 Connection Established");
    expect(text).toContain("hello from upstream");
  });
});
