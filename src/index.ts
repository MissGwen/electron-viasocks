/**
 * electron-viasocks 公共 API 出口。
 *
 * 导出面刻意保持最小（入口函数 + 类型 + 错误类），内部模块全部私有，
 * 后续重构不构成破坏性变更。
 */

export { createProxy, createProxyFromUrl } from "./createProxy";
export type { ParsedSocksUrl, ProxyHandle, ProxyOptions, SocksType } from "./types";
export type { ViaSocksErrorCode } from "./ViaSocksError";
export { ViaSocksError } from "./ViaSocksError";
