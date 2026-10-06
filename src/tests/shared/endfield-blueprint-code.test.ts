import { describe, expect, it } from "vitest";

import {
  BLUEPRINT_CODE_FAILURE_MESSAGE,
  BLUEPRINT_CODE_PATTERN,
  parseBlueprintCodeInput,
} from "@/shared/endfield/blueprint-code";

describe("蓝图码格式校验（陆服）", () => {
  it("合法码样本全部通过（本地 fixture + 网上陆服攻略样本）", () => {
    const validCodes = [
      "EF0108131aE82iAIE179", // 壤晶
      "EF013Eo0i2O06aU0579", // bp_simple
      "EF015i2O4O271uaUOeIoe", // bp_user 龙泡泡一期
      "EF013Eou8uo47auUu0579", // 武陵1
      "EF01eaAoI2IAE4aoAi8", // 网上样本：新手开荒A图
      "EF01u28U7a78103AoOU", // 网上样本：源矿发电站
      "EF015i2163628uIeIoe", // 网上样本：荞愈胶囊
    ];
    for (const code of validCodes) {
      expect(BLUEPRINT_CODE_PATTERN.test(code), code).toBe(true);
    }
  });

  it("外服码（EFO 前缀）拒绝并报非陆服", () => {
    const result = parseBlueprintCodeInput("EFO01eAo0I01OI4Aoui8");
    expect(result.codes).toEqual([]);
    expect(result.failures).toEqual([
      { fragment: "EFO01eAo0I01OI4Aoui8", reason: "non-cn-server" },
    ]);
    expect(BLUEPRINT_CODE_FAILURE_MESSAGE["non-cn-server"]).toContain("中国大陆");
  });

  it("空格容错：剥离空格/换行/全角空格后通过", () => {
    expect(parseBlueprintCodeInput("  EF013Eo0i2O06aU0579 ").codes).toEqual(["EF013Eo0i2O06aU0579"]);
    expect(parseBlueprintCodeInput("EF013Eo0i2O06aU0579\n").codes).toEqual(["EF013Eo0i2O06aU0579"]);
    expect(parseBlueprintCodeInput("　EF013Eo0i2O06aU0579　").codes).toEqual(["EF013Eo0i2O06aU0579"]);
  });

  it("多码：逗号/换行/空格分隔 + 粘连切分", () => {
    expect(
      parseBlueprintCodeInput("EF013Eo0i2O06aU0579，EF015i2O4O271uaUOeIoe").codes,
    ).toEqual(["EF013Eo0i2O06aU0579", "EF015i2O4O271uaUOeIoe"]);
    expect(
      parseBlueprintCodeInput("EF013Eo0i2O06aU0579\nEF015i2O4O271uaUOeIoe").codes,
    ).toEqual(["EF013Eo0i2O06aU0579", "EF015i2O4O271uaUOeIoe"]);
    // 粘连（无分隔符）
    expect(
      parseBlueprintCodeInput("EF013Eo0i2O06aU0579EF015i2O4O271uaUOeIoe").codes,
    ).toEqual(["EF013Eo0i2O06aU0579", "EF015i2O4O271uaUOeIoe"]);
  });

  it("混入说明文字：提取码，文字忽略", () => {
    const result = parseBlueprintCodeInput("武陵毕业蓝图：EF013Eou8uo47auUu0579 一键毕业");
    expect(result.codes).toEqual(["EF013Eou8uo47auUu0579"]);
    expect(result.failures).toEqual([]);
  });

  it("非法字符：报错并指明字符集", () => {
    const result = parseBlueprintCodeInput("EF013Eo0i2O06aU057X");
    expect(result.codes).toEqual([]);
    expect(result.failures).toEqual([
      { fragment: "EF013Eo0i2O06aU057X", reason: "bad-charset" },
    ]);
  });

  it("长度越界：过短/过长报错", () => {
    expect(parseBlueprintCodeInput("EF013Eo0i2").failures[0]?.reason).toBe("bad-length");
    expect(
      parseBlueprintCodeInput("EF013Eo0i2O06aU0579aaaaa").failures[0]?.reason,
    ).toBe("bad-length");
  });

  it("非 EF 前缀片段跳过（视为说明文字）", () => {
    const result = parseBlueprintCodeInput("hello world");
    expect(result.codes).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("重复码去重", () => {
    expect(
      parseBlueprintCodeInput("EF013Eo0i2O06aU0579 EF013Eo0i2O06aU0579").codes,
    ).toEqual(["EF013Eo0i2O06aU0579"]);
  });
});
