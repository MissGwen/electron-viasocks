/**
 * 错误处理与资源清理测试（F 组）。
 *
 * 覆盖：
 * - 上游空闲超时 -> 502 且错误码 TIMEOUT
 * - 客户端中途断开 -> 上游连接被清理（mock.activeTunnels 归零，无泄漏）
 * - 空闲 CONNECT 隧道超时 -> 双端销毁
 * - close() 期间有活跃隧道 -> 隧道被切断而非挂死
 * - 并发请求进行中 close() 不崩溃
 */

import http from "node:http";
import type { Socket } from "node:net";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProxyHandle } from "../src";
import { createProxy } from "../src";
import type { MockSocksHandle } from "./fixtures/socks5Server";
import { startMockSocksServer } from "./fixtures/socks5Server";
import type { UpstreamHandle } from "./fixtures/upstreamServer";
import { startHttpsUpstream, startHttpUpstream } from "./fixtures/upstreamServer";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("error handling and cleanup", () => {
  let mock: MockSocksHandle;
  let upstream: UpstreamHandle;
  let tlsUpstream: UpstreamHandle;
  const handles: ProxyHandle[] = [];

  beforeAll(async () => {
    mock = await startMockSocksServer();
    upstream = await startHttpUpstream();
    tlsUpstream = await startHttpsUpstream();
  });

  afterAll(async () => {
    await Promise.allSettled(handles.map((h) => h.close()));
    await upstream.close();
    await tlsUpstream.close();
    await mock.close();
  });

  async function proxyWith(opts: { timeout?: number } = {}): Promise<ProxyHandle> {
    const h = await createProxy({ proxy: mock.socks5Url(), ...opts });
    handles.push(h);
    return h;
  }

  it("upstream idle timeout -> 502 with TIMEOUT code", async () => {
    const proxy = await proxyWith({ timeout: 300 });
    // /slow/2000：上游 2 秒后才回包，代理侧 300ms 空闲超时先触发。
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxy.port,
          path: `${upstream.baseUrl}/slow/2000`,
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
    expect(res.status).toBe(502);
    expect(res.body).toContain("TIMEOUT");
  });

  it("client disconnect mid-request cleans up the upstream tunnel", async () => {
    const proxy = await proxyWith(); // 默认 30s 超时，确保清理靠的是断连逻辑而非超时

    // 发一个 /slow/2000 请求，100ms 后客户端主动断开。
    // attach error 监听：destroy() 必然触发 error，不接住会变成 uncaught。
    const req = http.request({
      host: "127.0.0.1",
      port: proxy.port,
      path: `${upstream.baseUrl}/slow/2000`,
    });
    req.on("error", () => {
      /* 预期内的连接中断 */
    });
    req.end();
    await sleep(100);
    req.destroy();

    // 给错误传播与对端清理留时间（SOCKS 侧 FIN 传播是异步的），
    // 然后断言 mock 侧隧道归零：客户端断开后上游隧道没有泄漏挂着。
    await sleep(400);
    expect(mock.activeTunnels).toBe(0);
    // 再等到 /slow/2000 本身也过期，确认绝无残留
    await sleep(1800);
    expect(mock.activeTunnels).toBe(0);
  });

  it("idle CONNECT tunnel is destroyed after the configured timeout", async () => {
    const proxy = await proxyWith({ timeout: 300 });
    const proxyUrl = new URL(proxy.url);

    // 建隧道，等 200 Connection Established，然后什么都不发。
    const socket: Socket = net.connect(Number(proxyUrl.port), "127.0.0.1");
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("data", (buf: Buffer) => {
        expect(buf.toString("latin1")).toContain("200");
        resolve();
      });
      socket.write(
        `CONNECT 127.0.0.1:${tlsUpstream.port} HTTP/1.1\r\nHost: 127.0.0.1:${tlsUpstream.port}\r\n\r\n`,
      );
    });

    // 空闲超过 300ms -> 双端销毁 -> 客户端 socket 收到 close。
    // 若超时逻辑失效，这个 race 会输给 2 秒的兜底超时而失败。
    await Promise.race([closed, sleep(2000).then(() => expect.fail("tunnel not cleaned up"))]);
    socket.destroy();
  });

  it("close() severs an active idle tunnel", async () => {
    const proxy = await proxyWith(); // 30s 超时，确保切断来自 close() 而非超时
    const proxyUrl = new URL(proxy.url);

    const socket: Socket = net.connect(Number(proxyUrl.port), "127.0.0.1");
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("data", () => resolve());
      socket.write(
        `CONNECT 127.0.0.1:${tlsUpstream.port} HTTP/1.1\r\nHost: 127.0.0.1:${tlsUpstream.port}\r\n\r\n`,
      );
    });

    await proxy.close();
    await Promise.race([closed, sleep(2000).then(() => expect.fail("close() left tunnel open"))]);
    socket.destroy();
  });

  it("close() during in-flight concurrent requests does not crash the process", async () => {
    const proxy = await proxyWith();
    const proxyUrl = new URL(proxy.url);

    // 5 个并发 /slow/1500 请求在途时直接 close()
    const inflight = Array.from(
      { length: 5 },
      () =>
        new Promise<"settled">((resolve) => {
          const req = http.request(
            {
              host: "127.0.0.1",
              port: Number(proxyUrl.port),
              path: `${upstream.baseUrl}/slow/1500`,
            },
            () => resolve("settled"),
          );
          req.on("error", () => resolve("settled")); // 被切断算正常
          req.end();
        }),
    );
    await sleep(100); // 等请求真正在途
    await proxy.close(); // 不应抛错
    await Promise.allSettled(inflight); // 每个请求都有确定结局（响应或错误）
    expect(true).toBe(true); // 走到这里 = 没崩溃、没挂死
  });
});
