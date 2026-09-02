import { defineConfig } from "vitest/config";

/**
 * Vitest 配置。
 *
 * 覆盖率只统计 src/（fixtures 不算分母）：
 * 行/语句/函数 >= 90%，分支 >= 85%。
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // e2e 测试要起真实 socket，Windows 上握手稍慢，给足余量。
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // 同文件内保持串行，避免真实端口/socket 相互干扰；
    // 不同文件由 vitest 并行跑（各自独立的端口空间，互不影响）。
    pool: "threads",
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/index.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
      },
    },
  },
});
