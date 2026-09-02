/**
 * stripHopByHopHeaders 单元测试。
 *
 * 直接测纯函数，把网络路径不容易构造的分支（数组形态的 Connection、
 * 空段、无 Connection 头等）全部覆盖。
 */

import { describe, expect, it } from "vitest";
import { stripHopByHopHeaders } from "../src/headers";

describe("stripHopByHopHeaders", () => {
  it("keeps end-to-end headers untouched", () => {
    const out = stripHopByHopHeaders({
      host: "example.com",
      "content-type": "text/plain",
      "x-custom": "kept",
    });
    expect(out).toEqual({
      host: "example.com",
      "content-type": "text/plain",
      "x-custom": "kept",
    });
  });

  it("removes well-known hop-by-hop headers", () => {
    const out = stripHopByHopHeaders({
      host: "example.com",
      connection: "close",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      upgrade: "websocket",
      te: "trailers",
      trailer: "x-checksum",
      "proxy-connection": "keep-alive",
      "proxy-authorization": "Basic xyz",
      "proxy-authenticate": "Basic realm",
    });
    expect(out).toEqual({ host: "example.com" });
  });

  it("removes headers listed in the Connection value", () => {
    const out = stripHopByHopHeaders({
      host: "example.com",
      connection: "keep-alive, x-listed-a, X-Listed-B",
      "x-listed-a": "1",
      "x-listed-b": "2",
      "x-not-listed": "3",
    });
    // Connection 里列举的头（含大小写不敏感）都被剥掉
    expect(out).toEqual({ host: "example.com", "x-not-listed": "3" });
  });

  it("handles Connection values with empty segments (trailing/double commas)", () => {
    const out = stripHopByHopHeaders({
      connection: "a-header, , b-header,",
      "a-header": "1",
      "b-header": "2",
    });
    expect(out).toEqual({});
  });

  it("handles array-form Connection header (defensive path)", () => {
    // 类型上 IncomingHttpHeaders['connection'] 是 string，但运行时
    // Node 可能给出数组（重复头），这是防御分支。
    const out = stripHopByHopHeaders({
      host: "example.com",
      connection: ["x-one", "x-two"] as unknown as string,
      "x-one": "1",
      "x-two": "2",
    });
    expect(out).toEqual({ host: "example.com" });
  });

  it("does not mutate the input headers object", () => {
    const input = { host: "example.com", connection: "close" };
    const out = stripHopByHopHeaders(input);
    expect(input.connection).toBe("close");
    expect(out.connection).toBeUndefined();
  });

  it("normalizes header names to lowercase", () => {
    const out = stripHopByHopHeaders({
      "X-Mixed-Case": "v",
      Connection: "close",
    });
    expect(out["x-mixed-case"]).toBe("v");
  });
});
