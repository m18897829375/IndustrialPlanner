/**
 * 熵增 API（终末地官方蓝图码解析）类型。
 * Base URL 统一走相对前缀 `/entropy-api`（dev 由 vite proxy 转发，
 * 生产由 EdgeOne Functions / Cloudflare Workers 转发到 https://end-api.shallow.ink）。
 */

export interface AnonymousTokenResponse {
  readonly code: number;
  readonly message?: string;
  readonly data?: { readonly token?: string };
}

export interface BlueprintGetResponse {
  readonly code: number;
  readonly message?: string;
  readonly data?: {
    readonly data?: { readonly bluePrintData?: unknown };
  };
}
