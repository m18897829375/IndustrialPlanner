import type { OfficialBlueprintData } from "../official-blueprint-import/official-types";
import { extractOfficialBlueprintData } from "../official-blueprint-import/official-types";
import type {
  AnonymousTokenResponse,
  BlueprintGetResponse,
} from "./entropy-api-types";

/**
 * 熵增 API 客户端（移植自 fetch_blueprint.py）：
 *   1. 匿名鉴权：POST /api/v1/auth/anonymous-token（fingerprint = UUID，localStorage 持久化）
 *   2. 取蓝图：GET /api/blueprint/get?code=<码>（X-Anonymous-Token 头）
 * token 有效期 2h，内存缓存 + 提前 5 分钟重建；失败自动重建 token 重试一次。
 */

const DEFAULT_BASE_URL = "/entropy-api";
const FINGERPRINT_STORAGE_KEY = "endfield.anonFingerprint";
/** token 官方有效期 2h，提前 5 分钟重建。 */
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface EntropyClientConfig {
  /** 默认 "/entropy-api"（相对前缀，dev/生产代理由部署层提供）。 */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** 测试注入时钟。 */
  readonly now?: () => number;
}

export interface EntropyClient {
  fetchBlueprintByCode(code: string): Promise<OfficialBlueprintData>;
}

function createFingerprint(): string {
  // fetch_blueprint.py: uuid4().hex + uuid4().hex[:8]（≥32 位）
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

function loadFingerprint(): string {
  try {
    const cached = globalThis.localStorage?.getItem(FINGERPRINT_STORAGE_KEY);
    if (cached !== null && cached !== undefined && cached !== "") {
      return cached;
    }
    const created = createFingerprint();
    globalThis.localStorage?.setItem(FINGERPRINT_STORAGE_KEY, created);
    return created;
  } catch {
    // localStorage 不可用（隐私模式等）时退化为会话级指纹
    return createFingerprint();
  }
}

export function createEntropyClient(config: EntropyClientConfig = {}): EntropyClient {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  const now = config.now ?? (() => Date.now());

  let token: string | null = null;
  let tokenIssuedAt = 0;

  async function requestToken(): Promise<string> {
    const response = await fetchImpl(`${baseUrl}/api/v1/auth/anonymous-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint: loadFingerprint() }),
    });
    if (!response.ok) {
      throw new Error(`匿名令牌请求失败：HTTP ${response.status}`);
    }
    const payload = await response.json() as AnonymousTokenResponse;
    const issued = payload.data?.token;
    if (issued === undefined || issued === "") {
      throw new Error(`匿名令牌响应缺少 token：${payload.message ?? "未知错误"}`);
    }
    token = issued;
    tokenIssuedAt = now();
    return issued;
  }

  async function ensureToken(): Promise<string> {
    if (token !== null && now() - tokenIssuedAt < TOKEN_TTL_MS - TOKEN_REFRESH_MARGIN_MS) {
      return token;
    }
    return requestToken();
  }

  async function fetchBlueprintOnce(code: string): Promise<OfficialBlueprintData> {
    const currentToken = await ensureToken();
    const response = await fetchImpl(
      `${baseUrl}/api/blueprint/get?code=${encodeURIComponent(code)}`,
      { headers: { "X-Anonymous-Token": currentToken } },
    );
    if (!response.ok) {
      throw new Error(`蓝图查询失败：HTTP ${response.status}`);
    }
    const payload = await response.json() as BlueprintGetResponse;
    if (payload.code !== 0) {
      throw new Error(`蓝图查询返回错误：${payload.message ?? `code=${payload.code}`}`);
    }
    return extractOfficialBlueprintData(payload);
  }

  return {
    async fetchBlueprintByCode(code: string): Promise<OfficialBlueprintData> {
      try {
        return await fetchBlueprintOnce(code);
      } catch (error) {
        // token 失效等：强制重建重试一次
        token = null;
        try {
          return await fetchBlueprintOnce(code);
        } catch {
          throw error;
        }
      }
    },
  };
}
