/**
 * createProxy 生命周期测试（B 组）。
 *
 * 覆盖：
 * - 返回的 url/port/host 格式与实际监听一致
 * - close() 后端口真正释放（TCP 连不上了）
 * - close() 幂等（重复调用不炸）
 * - close() 会切断活跃连接（不干等长命隧道）
 * - 非法 proxy URL 抛 INVALID_URL
 * - 固定端口被占用抛 SERVER_BIND_FAILED
 * - createProxyFromUrl 便捷封装可用
 * - timeout 传 0（禁用）不会导致启动失败
 */

import type { Socket } from "node:net";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProxyHandle } from "../src";
import { createProxy, createProxyFromUrl, ViaSocksError } from "../src";
import type { MockSocksHandle } from "./fixtures/socks5Server";
import { startMockSocksServer } from "./fixtures/socks5Server";

/** 探测 host:port 是否可建立 TCP 连接（用来验证端口真的在/不在监听）。 */
function canConnect(port: number, host = "127.0.0.1", timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

/** 找一个当前空闲的端口（先占住再放掉，端口大概率仍空闲）。 */
async function grabFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

describe("createProxy lifecycle", () => {
  let mock: MockSocksHandle;

  beforeAll(async () => {
    mock = await startMockSocksServer();
  });

  afterAll(async () => {
    await mock.close();
  });

  it("returns a usable handle with url/port/host", async () => {
    const handle = await createProxy({ proxy: mock.socks5Url() });
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.host).toBe("127.0.0.1");
      expect(handle.port).toBeGreaterThan(0);
      // url 里的端口与 port 字段一致
      expect(handle.url.endsWith(`:${handle.port}`)).toBe(true);
      // 端口真实在监听
      expect(await canConnect(handle.port)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("port is actually released after close()", async () => {
    const handle = await createProxy({ proxy: mock.socks5Url() });
    expect(await canConnect(handle.port)).toBe(true);
    await handle.close();
    expect(await canConnect(handle.port)).toBe(false);
  });

  it("close() is idempotent", async () => {
    const handle = await createProxy({ proxy: mock.socks5Url() });
    await handle.close();
    await handle.close(); // 第二次不抛错
    await expect(handle.close()).resolves.toBeUndefined(); // 第三次也行
  });

  it("close() destroys active connections instead of hanging", async () => {
    const handle = await createProxy({ proxy: mock.socks5Url() });
    // 挂一条什么都不发的空闲连接（模拟长命隧道）。
    const idle: Socket = net.connect(handle.port, "127.0.0.1");
    const closed = new Promise<void>((resolve) => idle.once("close", () => resolve()));
    await new Promise<void>((resolve) => idle.once("connect", () => resolve()));

    // 若 close() 不销毁活跃连接，server.close 的回调要等连接自然结束，
    // 这个 await 会一直挂住直到测试超时。
    await Promise.race([
      handle.close().then(() => "closed"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close() hung")), 3000)),
    ]);
    await closed; // 空闲连接确实被切断了
    idle.destroy();
  });

  it("OS assigns different ports to different instances", async () => {
    const a = await createProxy({ proxy: mock.socks5Url() });
    const b = await createProxy({ proxy: mock.socks5Url() });
    try {
      expect(a.port).not.toBe(b.port);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("honors an explicit port", async () => {
    const port = await grabFreePort();
    const handle = await createProxy({ proxy: mock.socks5Url(), port });
    try {
      expect(handle.port).toBe(port);
      expect(await canConnect(port)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("throws SERVER_BIND_FAILED when the port is already taken", async () => {
    // 先占住一个端口
    const blocker = await new Promise<net.Server>((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = blocker.address() as net.AddressInfo;

    try {
      await createProxy({ proxy: mock.socks5Url(), port });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ViaSocksError);
      expect((e as ViaSocksError).code).toBe("SERVER_BIND_FAILED");
      expect((e as ViaSocksError).message).toContain(String(port));
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("throws INVALID_URL for a malformed proxy URL", async () => {
    await expect(createProxy({ proxy: "not a url" })).rejects.toMatchObject({
      code: "INVALID_URL",
    });
    await expect(createProxy({ proxy: "http://127.0.0.1:1080" })).rejects.toMatchObject({
      code: "INVALID_URL",
    });
  });

  it("createProxyFromUrl works with default options", async () => {
    const handle = await createProxyFromUrl(mock.socks5Url());
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await canConnect(handle.port)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("timeout=0 (disabled) does not break startup", async () => {
    const handle: ProxyHandle = await createProxy({ proxy: mock.socks5Url(), timeout: 0 });
    try {
      expect(handle.port).toBeGreaterThan(0);
    } finally {
      await handle.close();
    }
  });
});
