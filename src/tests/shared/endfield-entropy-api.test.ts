import { describe, expect, it } from "vitest";

import { createEntropyClient } from "@/shared/endfield/entropy-api";
import {
  readCachedBlueprint,
  writeCachedBlueprint,
} from "@/shared/endfield/entropy-cache";
import type { OfficialBlueprintData } from "@/shared/official-blueprint-import";

const SAMPLE_BLUEPRINT: OfficialBlueprintData = {
  name: "测试蓝图",
  desc: "",
  xSize: 10,
  zSize: 7,
  nodes: [],
};

function okJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function tokenResponse(token: string): Response {
  return okJsonResponse({ code: 0, data: { token } });
}

function blueprintResponse(): Response {
  return okJsonResponse({
    code: 0,
    message: "成功",
    data: { cache: false, data: { bluePrintData: SAMPLE_BLUEPRINT }, query: { code: "EF_TEST" } },
  });
}

describe("entropy-api 客户端", () => {
  it("首请求先取匿名 token，再带 X-Anonymous-Token 取蓝图", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.includes("/auth/anonymous-token")) return tokenResponse("token-1");
      return blueprintResponse();
    };
    const client = createEntropyClient({ fetchImpl });
    const data = await client.fetchBlueprintByCode("EF_TEST");
    expect(data.name).toBe("测试蓝图");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/entropy-api/api/v1/auth/anonymous-token");
    expect(calls[1]!.url).toContain("/entropy-api/api/blueprint/get?code=EF_TEST");
    expect(calls[1]!.headers["X-Anonymous-Token"]).toBe("token-1");
  });

  it("token 未过期时复用（第二次请求不再取 token）", async () => {
    let tokenCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("/auth/anonymous-token")) {
        tokenCalls++;
        return tokenResponse("token-1");
      }
      return blueprintResponse();
    };
    const client = createEntropyClient({ fetchImpl });
    await client.fetchBlueprintByCode("EF_A");
    await client.fetchBlueprintByCode("EF_B");
    expect(tokenCalls).toBe(1);
  });

  it("token 临近过期（2h-5min）自动重建", async () => {
    let tokenCalls = 0;
    let clock = 1_000_000;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("/auth/anonymous-token")) {
        tokenCalls++;
        return tokenResponse(`token-${tokenCalls}`);
      }
      return blueprintResponse();
    };
    const client = createEntropyClient({ fetchImpl, now: () => clock });
    await client.fetchBlueprintByCode("EF_A");
    clock += 2 * 60 * 60 * 1000 - 4 * 60 * 1000; // 1h56m（越过提前 5min 阈值）
    await client.fetchBlueprintByCode("EF_B");
    expect(tokenCalls).toBe(2);
  });

  it("查询失败自动重建 token 重试一次", async () => {
    let blueprintCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/auth/anonymous-token")) return tokenResponse("token-x");
      blueprintCalls++;
      if (blueprintCalls === 1) return new Response("boom", { status: 401 });
      return blueprintResponse();
    };
    const client = createEntropyClient({ fetchImpl });
    const data = await client.fetchBlueprintByCode("EF_RETRY");
    expect(data.name).toBe("测试蓝图");
    expect(blueprintCalls).toBe(2);
  });

  it("API 错误码抛出带 message 的错误", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("/auth/anonymous-token")) return tokenResponse("t");
      return okJsonResponse({ code: 404, message: "蓝图不存在" });
    };
    const client = createEntropyClient({ fetchImpl });
    await expect(client.fetchBlueprintByCode("EF_BAD")).rejects.toThrow("蓝图不存在");
  });
});

describe("entropy-cache（localStorage LRU）", () => {
  it("写入后可读取；未命中返回 null", () => {
    localStorage.clear();
    expect(readCachedBlueprint("EF_NONE")).toBeNull();
    writeCachedBlueprint("EF_X", SAMPLE_BLUEPRINT);
    expect(readCachedBlueprint("EF_X")?.name).toBe("测试蓝图");
  });

  it("超出 LRU 上限淘汰最久未用条目", () => {
    localStorage.clear();
    for (let i = 0; i < 55; i++) {
      writeCachedBlueprint(`EF_${i}`, SAMPLE_BLUEPRINT);
    }
    expect(readCachedBlueprint("EF_0")).toBeNull(); // 最早写入被淘汰
    expect(readCachedBlueprint("EF_54")?.name).toBe("测试蓝图");
  });
});
