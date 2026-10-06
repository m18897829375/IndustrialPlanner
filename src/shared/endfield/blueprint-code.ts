/**
 * 终末地蓝图码（中国大陆服务器）格式校验与粘贴文本提取。
 *
 * 格式约束（本地 8 份 + 网上陆服攻略样本双重实证）：
 *   - `EF01` 前缀（EF + 数字 01；EFO 开头为外服格式，不支持）
 *   - 总长 19-23（主流 21 = EF01 + 17 位）
 *   - 字符集 15 个：0-9 / AEFIOU / aeiou（含易混淆对 0/O、1/I，校验不混淆）
 *
 * 用户最常见错误：复制时多带空格/换行/说明文字 → 先剥离空白、从文本提取类码子串，
 * 残片逐条报具体原因（不静默丢弃）。
 */

/** 陆服蓝图码：EF01 前缀 + 15-19 位码字符（总长 19-23）。 */
export const BLUEPRINT_CODE_PATTERN = /^EF01[0-9AEFIOUaeiou]{15,19}$/;

const WHITESPACE_PATTERN = /[ \t\r\n　]/g; // eslint-disable-line no-irregular-whitespace -- 全角空格是目标字符（复制场景高发）

/** 码字符之外的字符（切分用）。 */
const NON_CODE_CHAR_PATTERN = /[^0-9A-Za-z]+/g;

export type BlueprintCodeParseFailureReason =
  | "not-ef-prefix"
  | "non-cn-server"
  | "bad-charset"
  | "bad-length";

export interface BlueprintCodeParseResult {
  /** 合法蓝图码（已剥离空白）。 */
  readonly codes: readonly string[];
  /** 无法识别的片段及原因（含原文片段，便于用户定位）。 */
  readonly failures: readonly { readonly fragment: string; readonly reason: BlueprintCodeParseFailureReason }[];
}

function classifyFragment(fragment: string): BlueprintCodeParseFailureReason {
  if (!fragment.startsWith("EF")) {
    return "not-ef-prefix";
  }
  if (fragment.startsWith("EFO") || !fragment.startsWith("EF01")) {
    return "non-cn-server";
  }
  if (!/^EF01[0-9AEFIOUaeiou]+$/.test(fragment)) {
    return "bad-charset";
  }
  return "bad-length";
}

/**
 * 解析用户粘贴输入：剥离空白 → 提取类码子串 → 逐个校验。
 * 非码字符（中文说明、标点等）作为分隔符忽略；EF 开头但不合法的片段进 failures。
 */
export function parseBlueprintCodeInput(input: string): BlueprintCodeParseResult {
  // 剥离全部空白（含全角空格），按非码字符切分，再按 EF01 锚点切粘连段
  const stripped = input.replace(WHITESPACE_PATTERN, "");
  const segments = stripped
    .split(NON_CODE_CHAR_PATTERN)
    .flatMap((segment) => segment.split(/(?=EF01|EFO)/))
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  const codes: string[] = [];
  const failures: { fragment: string; reason: BlueprintCodeParseFailureReason }[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    if (!segment.startsWith("EF")) continue; // 非码残留（说明文字残片等）跳过
    if (seen.has(segment)) continue;
    seen.add(segment);
    if (BLUEPRINT_CODE_PATTERN.test(segment)) {
      codes.push(segment);
    } else {
      failures.push({ fragment: segment, reason: classifyFragment(segment) });
    }
  }
  return { codes, failures };
}

export const BLUEPRINT_CODE_FAILURE_MESSAGE: Record<BlueprintCodeParseFailureReason, string> = {
  "not-ef-prefix": "蓝图码应以 EF 开头",
  "non-cn-server": "仅支持中国大陆服务器蓝图码（EF01 开头）",
  "bad-charset": "包含非法字符（合法字符：0-9、A/E/F/I/O/U、a/e/i/o/u）",
  "bad-length": "长度不符（陆服蓝图码共 19-23 位）",
};
