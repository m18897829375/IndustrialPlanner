import type { OfficialBlueprintData } from "../official-blueprint-import/official-types";

/**
 * 蓝图码 → 官方解析 JSON 的 localStorage 缓存。
 * 同一蓝图码内容不可变（服务端按码索引），缓存安全。
 * LRU 上限 50 条，单条写入 4MB 尺寸守卫。
 */

const CACHE_KEY_PREFIX = "endfield.bp.";
const CACHE_INDEX_KEY = "endfield.bp.index";
const MAX_ENTRIES = 50;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

function loadIndex(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_INDEX_KEY);
    if (raw == null || raw === "") return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function saveIndex(index: string[]): void {
  try {
    globalThis.localStorage?.setItem(CACHE_INDEX_KEY, JSON.stringify(index));
  } catch {
    // 存储不可用时静默降级（缓存是优化，不是功能）
  }
}

export function readCachedBlueprint(code: string): OfficialBlueprintData | null {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY_PREFIX + code);
    if (raw == null || raw === "") return null;
    // 命中后提升为最近使用
    const index = loadIndex().filter((k) => k !== code);
    index.push(code);
    saveIndex(index);
    return JSON.parse(raw) as OfficialBlueprintData;
  } catch {
    return null;
  }
}

export function writeCachedBlueprint(code: string, data: OfficialBlueprintData): void {
  try {
    const payload = JSON.stringify(data);
    if (payload.length > MAX_PAYLOAD_BYTES) return;
    globalThis.localStorage?.setItem(CACHE_KEY_PREFIX + code, payload);
    let index = loadIndex().filter((k) => k !== code);
    index.push(code);
    // LRU 淘汰最久未用
    while (index.length > MAX_ENTRIES) {
      const evicted = index.shift();
      if (evicted !== undefined) {
        globalThis.localStorage?.removeItem(CACHE_KEY_PREFIX + evicted);
      }
    }
    index = index.filter((k) => k !== undefined);
    saveIndex(index);
  } catch {
    // 配额满等：静默降级
  }
}
