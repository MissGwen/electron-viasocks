import { defineConfig } from "@rslib/core";

/**
 * Rslib 构建配置，产物均在 dist/ 下：
 * ESM（index.js + index.d.ts）与 CJS（index.cjs + index.d.cts）。
 *
 * 两个关键开关：
 * - dts.bundle: true —— 声明文件按入口依赖图聚合为单文件，
 *   否则会按 tsconfig include 逐文件输出（连 test/ 都会进产物）；
 * - dts.autoExtension: true —— CJS 的声明文件用 .d.cts。注意它与 lib 级
 *   autoExtension（默认开启）是两个独立开关，不开启时 CJS 声明也是 .d.ts，
 *   与 ESM 的输出路径冲突。
 *
 * 运行时依赖（socks、socks-proxy-agent）由 Rslib 自动 external 化。
 */
export default defineConfig({
  source: {
    entry: { index: "./src/index.ts" },
  },
  lib: [
    {
      format: "esm",
      dts: { bundle: true, autoExtension: true },
      syntax: "es2022",
      output: {
        sourceMap: true,
      },
    },
    {
      format: "cjs",
      dts: { bundle: true, autoExtension: true },
      syntax: "es2022",
      output: {
        sourceMap: true,
      },
    },
  ],
});
