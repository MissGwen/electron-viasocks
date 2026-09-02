/**
 * parseSocksUrl 单元测试（A 组）。
 *
 * 覆盖：
 * - 三种 scheme 的标准解析（socks4/socks5/socks5h）
 * - 凭据 percent-encoding 解码（含 `@`/`:`/`/` 等特殊字符）
 * - 缺省端口默认 1080
 * - IPv6 字面量（方括号剥离）
 * - 非法协议 / 空 host / 越界端口 等错误路径
 */

import { describe, expect, it } from "vitest";
import { parseSocksUrl } from "../src/parseSocksUrl";
import { ViaSocksError } from "../src/ViaSocksError";

describe("parseSocksUrl", () => {
  describe("standard forms", () => {
    it("parses socks5 with user:pass", () => {
      const r = parseSocksUrl("socks5://user:pass@host:1080");
      expect(r).toEqual({
        type: "socks5",
        host: "host",
        port: 1080,
        userId: "user",
        password: "pass",
      });
    });

    it("parses socks4 without auth", () => {
      const r = parseSocksUrl("socks4://host:1080");
      expect(r).toEqual({ type: "socks4", host: "host", port: 1080 });
      expect(r.userId).toBeUndefined();
      expect(r.password).toBeUndefined();
    });

    it("parses socks4 with userId only (socks4 has no password)", () => {
      const r = parseSocksUrl("socks4://someuser@host:1080");
      expect(r).toEqual({
        type: "socks4",
        host: "host",
        port: 1080,
        userId: "someuser",
      });
      expect(r.password).toBeUndefined();
    });

    it("parses socks5h (remote DNS)", () => {
      const r = parseSocksUrl("socks5h://user:pass@host:1080");
      expect(r).toEqual({
        type: "socks5h",
        host: "host",
        port: 1080,
        userId: "user",
        password: "pass",
      });
    });

    it("parses socks5 with only username (no password)", () => {
      const r = parseSocksUrl("socks5://justuser@host:1080");
      expect(r).toEqual({
        type: "socks5",
        host: "host",
        port: 1080,
        userId: "justuser",
      });
      expect(r.password).toBeUndefined();
    });
  });

  describe("credential percent-decoding", () => {
    it("decodes @ in password (encoded as %40)", () => {
      const r = parseSocksUrl("socks5://user:p%40ss@host:1080");
      expect(r.password).toBe("p@ss");
    });

    it("decodes : in username (encoded as %3A)", () => {
      const r = parseSocksUrl("socks5://u%3Aser:pass@host:1080");
      expect(r.userId).toBe("u:ser");
    });

    it("decodes / in password (encoded as %2F)", () => {
      const r = parseSocksUrl("socks5://user:p%2Fss@host:1080");
      expect(r.password).toBe("p/ss");
    });

    it("decodes multiple special chars in credentials", () => {
      const r = parseSocksUrl("socks5://us%40er:p%3A%40ss@host:1080");
      expect(r.userId).toBe("us@er");
      expect(r.password).toBe("p:@ss");
    });

    it("handles unicode in password (encoded UTF-8)", () => {
      const r = parseSocksUrl("socks5://user:p%C3%A4ss@host:1080");
      expect(r.password).toBe("päss");
    });
  });

  describe("port handling", () => {
    it("defaults to 1080 when port omitted", () => {
      const r = parseSocksUrl("socks5://user:pass@host");
      expect(r.port).toBe(1080);
    });

    it("accepts port 1 (minimum)", () => {
      const r = parseSocksUrl("socks5://host:1");
      expect(r.port).toBe(1);
    });

    it("accepts port 65535 (maximum)", () => {
      const r = parseSocksUrl("socks5://host:65535");
      expect(r.port).toBe(65535);
    });

    it("rejects port 0", () => {
      expect(() => parseSocksUrl("socks5://host:0")).toThrow(ViaSocksError);
      expect(() => parseSocksUrl("socks5://host:0")).toThrow(
        expect.objectContaining({ code: "INVALID_URL" }),
      );
    });

    it("rejects port > 65535", () => {
      expect(() => parseSocksUrl("socks5://host:99999")).toThrow(
        expect.objectContaining({ code: "INVALID_URL" }),
      );
    });

    it("rejects non-numeric port", () => {
      expect(() => parseSocksUrl("socks5://host:abc")).toThrow(
        expect.objectContaining({ code: "INVALID_URL" }),
      );
    });
  });

  describe("IPv6 host", () => {
    it("parses IPv6 host and strips brackets", () => {
      const r = parseSocksUrl("socks5://user:pass@[::1]:1080");
      expect(r.host).toBe("::1");
      expect(r.port).toBe(1080);
    });

    it("parses IPv6 with default port", () => {
      const r = parseSocksUrl("socks5://[::1]");
      expect(r.host).toBe("::1");
      expect(r.port).toBe(1080);
    });

    it("parses full IPv6 address", () => {
      const r = parseSocksUrl("socks5://[2001:db8::1]:1080");
      expect(r.host).toBe("2001:db8::1");
    });
  });

  describe("errors", () => {
    it("throws INVALID_URL for empty string", () => {
      expect(() => parseSocksUrl("")).toThrow(expect.objectContaining({ code: "INVALID_URL" }));
    });

    it("throws INVALID_URL for non-string", () => {
      expect(() => parseSocksUrl(null as unknown as string)).toThrow(
        expect.objectContaining({ code: "INVALID_URL" }),
      );
    });

    it("throws INVALID_URL for http scheme", () => {
      expect(() => parseSocksUrl("http://user:pass@host:1080")).toThrow(
        expect.objectContaining({ code: "INVALID_URL" }),
      );
    });

    it("throws INVALID_URL for unsupported socks variant (socks6)", () => {
      expect(() => parseSocksUrl("socks6://host:1080")).toThrow(
        expect.objectContaining({ code: "INVALID_URL" }),
      );
    });

    it("throws INVALID_URL for malformed URL", () => {
      expect(() => parseSocksUrl("socks5://[unclosed")).toThrow(
        expect.objectContaining({ code: "INVALID_URL" }),
      );
    });

    it("preserves cause from underlying URL parse failure", () => {
      try {
        parseSocksUrl("socks5://[unclosed");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ViaSocksError);
        expect((e as ViaSocksError).code).toBe("INVALID_URL");
        expect((e as ViaSocksError).cause).toBeDefined();
      }
    });

    it("throws INVALID_URL for malformed percent-encoding in password", () => {
      // `%ZZ` 不是合法的 percent-encoding
      expect(() => parseSocksUrl("socks5://user:p%ZZss@host:1080")).toThrow(
        expect.objectContaining({ code: "INVALID_URL" }),
      );
    });
  });

  describe("ViaSocksError properties", () => {
    it("sets name to ViaSocksError", () => {
      try {
        parseSocksUrl("http://host:1080");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ViaSocksError);
        expect((e as Error).name).toBe("ViaSocksError");
        expect((e as ViaSocksError).code).toBe("INVALID_URL");
      }
    });

    it("is correctly identified by instanceof", () => {
      try {
        parseSocksUrl("");
      } catch (e) {
        expect(e).toBeInstanceOf(ViaSocksError);
        expect(e).toBeInstanceOf(Error);
      }
    });
  });
});
