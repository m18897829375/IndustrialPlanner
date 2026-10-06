import { describe, expect, it } from "vitest";

import { createRegistryContract } from "@/registry";
import {
  dirAngle,
  expandPolyline,
  nodeOfficialRot,
  officialFootprintOrigin,
  toPlatformPosition,
} from "@/shared/official-blueprint-import/official-anchor";
import {
  expandPlacementDefaultsLocal,
} from "@/shared/official-blueprint-import/official-config";
import { resolveOfficialDefinitionId } from "@/shared/official-blueprint-import/official-id-map";
import { classifyLogistics } from "@/shared/official-blueprint-import/official-logistics";
import type { OfficialBlueprintNode } from "@/shared/official-blueprint-import/official-types";

describe("official-anchor 纯函数", () => {
  it("nodeOfficialRot：rotation.y 优先，缺失回退 direction.y", () => {
    const withRotation = {
      transform: { rotation: { x: 0, y: 450, z: 0 }, direction: { x: 0, y: 90, z: 0 } },
    } as OfficialBlueprintNode;
    expect(nodeOfficialRot(withRotation)).toBe(90); // 450 % 360
    const onlyDirection = {
      transform: { rotation: null, direction: { x: 0, y: 270, z: 0 } },
    } as unknown as OfficialBlueprintNode;
    expect(nodeOfficialRot(onlyDirection)).toBe(270);
    const empty = { transform: {} } as OfficialBlueprintNode;
    expect(nodeOfficialRot(empty)).toBe(0);
  });

  it("officialFootprintOrigin：官方锚点 4 分支 + rot 90/270 宽高互换", () => {
    // 3×5 设备（W=3, H=5）；rot∈{90,270} 时占地 w=5 h=3
    expect(officialFootprintOrigin(10, 20, 0, 3, 5)).toEqual({ x0: 10, z0: 20, w: 3, h: 5 });
    expect(officialFootprintOrigin(10, 20, 90, 3, 5)).toEqual({ x0: 10, z0: 18, w: 5, h: 3 });
    expect(officialFootprintOrigin(10, 20, 180, 3, 5)).toEqual({ x0: 8, z0: 16, w: 3, h: 5 });
    expect(officialFootprintOrigin(10, 20, 270, 3, 5)).toEqual({ x0: 6, z0: 20, w: 5, h: 3 });
  });

  it("toPlatformPosition：Z 镜像 y = zMax - z0 - (h-1)", () => {
    const footprint = { x0: 4, z0: 10, w: 3, h: 3 };
    expect(toPlatformPosition(footprint, 35)).toEqual({ x: 4, y: 23 }); // 35-10-2
  });

  it("expandPolyline：逐格插值 + 相邻去重 + 零长段处理", () => {
    expect(expandPolyline([{ x: 0, y: 0 }, { x: 3, y: 0 }])).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 },
    ]);
    // 折线 + 零长段（同点重复）
    expect(expandPolyline([
      { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 2 }, { x: 2, y: 2 },
    ])).toEqual([
      { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 },
    ]);
  });

  it("dirAngle：平台流向角 0=E 90=S 180=W 270=N", () => {
    expect(dirAngle(1, 0)).toBe(0);
    expect(dirAngle(0, 1)).toBe(90);
    expect(dirAngle(-1, 0)).toBe(180);
    expect(dirAngle(0, -1)).toBe(270);
    expect(dirAngle(0, 0)).toBeNull();
  });
});

describe("official-logistics classifyLogistics 查表", () => {
  it("straight：dIn == dOut", () => {
    expect(classifyLogistics(90, 90)).toEqual({ shape: "straight", rotation: 90 });
  });
  it("turn_cw：(dOut-dIn)%360==90，rot=(dIn+180)%360", () => {
    expect(classifyLogistics(0, 90)).toEqual({ shape: "turn_cw", rotation: 180 });
    expect(classifyLogistics(270, 0)).toEqual({ shape: "turn_cw", rotation: 90 });
  });
  it("turn_ccw：(dOut-dIn)%360==270，rot=(dIn+270)%360", () => {
    expect(classifyLogistics(90, 0)).toEqual({ shape: "turn_ccw", rotation: 0 });
    expect(classifyLogistics(0, 270)).toEqual({ shape: "turn_ccw", rotation: 270 });
  });
});

describe("official-id-map", () => {
  const registry = createRegistryContract();

  it("ID 别名表目标全部在注册表存在", () => {
    const cases: Array<[string, string]> = [
      ["component_mc_1", "cmpt_mc_1"],
      ["tools_assebling_mc_1", "tools_asm_mc_1"],
      ["power_station_1", "power_sta_1"],
      ["log_conditioner", "log_admission"],
      ["log_pipe_conditioner", "pipe_admission"],
      ["power_diffuser_2", "power_diffuser_1"],
      ["seedcollector_1", "seedcol_1"],
    ];
    for (const [official, platform] of cases) {
      const resolved = resolveOfficialDefinitionId(official, [], registry);
      expect(resolved?.definitionId, `${official} → ${platform}`).toBe(platform);
    }
  });

  it("模式变体分流：furnance_1+liquid → furnance_1_liquid；planter_1+liquid → planter_1_liquid", () => {
    const liquidComs = [{ comPos: 18, comType: 9, formulaMan: { curMode: "liquid" } }];
    expect(resolveOfficialDefinitionId("furnance_1", liquidComs, registry)?.definitionId)
      .toBe("furnance_1_liquid");
    expect(resolveOfficialDefinitionId("planter_1", liquidComs, registry)?.definitionId)
      .toBe("planter_1_liquid");
    const normalComs = [{ comPos: 18, comType: 9, formulaMan: { curMode: "normal" } }];
    expect(resolveOfficialDefinitionId("furnance_1", normalComs, registry)?.definitionId)
      .toBe("furnance_1");
  });

  it("未知 templateId 返回 null（不抛错）", () => {
    expect(resolveOfficialDefinitionId("nonexistent_device_1", [], registry)).toBeNull();
  });
});

describe("placementDefaults 展开与推导键冲突守卫", () => {
  const registry = createRegistryContract();

  it("expandPlacementDefaultsLocal：[Self] 占位符替换 + config 浅拷贝", () => {
    const storager = registry.queries.findEntityDefinition("storager_1")!;
    const expanded = expandPlacementDefaultsLocal(storager, "storager_1:7");
    // storager_1 placementDefaults 含 channelRecipes.warehouse_submit（entity-definition.ts:1112）
    expect(expanded.config).toMatchObject({
      channelRecipes: { warehouse_submit: "r_warehouse_submit" },
    });
    // 不污染原定义
    expect(storager.placementDefaults?.config).toBeDefined();
    expect(expanded.config).not.toBe(storager.placementDefaults!.config);
  });

  it("全量定义遍历：placementDefaults 键与官方推导键命名空间无交集", () => {
    // 官方推导写入的键模式（official-config.ts buildOfficialConfig）
    const derivedKeyPatterns = [
      /^storageSlotGroups\[\d+\]\.slots\[\d+\]\.ignoreStock$/, // unloader
      /^portGroups\[\d+\]\.ports\[\d+\]\.acceptRule$/, // admission / mix_pool 输出端口
      /^portGroups\[\d+\]\.ports\[\d+\]\.admissionRule$/, // admission
    ];
    const conflicts: string[] = [];
    for (const definition of registry.entityDefinitions) {
      const defaultsConfig = definition.placementDefaults?.config ?? {};
      for (const key of Object.keys(defaultsConfig)) {
        if (derivedKeyPatterns.some((pattern) => pattern.test(key))) {
          conflicts.push(`${definition.id}: ${key}`);
        }
        // channelRecipes 子键冲突：推导只写 default / ch1 / ch2
        if (key === "channelRecipes") {
          const channels = Object.keys(defaultsConfig[key] as Record<string, unknown>);
          for (const channel of channels) {
            if (channel === "default" || channel === "ch1" || channel === "ch2") {
              conflicts.push(`${definition.id}: channelRecipes.${channel}`);
            }
          }
        }
      }
    }
    expect(conflicts).toEqual([]);
  });
});

// ============================================================================
// R1：反应池配方与输出规则（2026-09-22 修复）
// ============================================================================
describe("R1 mix_pool selector 与白名单", () => {
  const registry = createRegistryContract();

  it("collectMixPoolSelectors：comPos 61=固体口、62-66=液体口按 comPos 排序（coms 乱序容错）", async () => {
    const { collectMixPoolSelectors } = await import(
      "@/shared/official-blueprint-import/official-config"
    );
    // 乱序 coms（官方数据实证：同蓝图两次抓取顺序不同）
    const coms = [
      { comPos: 63, comType: 6, selector: { selectedItemId: "item_liquid_b" } },
      { comPos: 18, comType: 9, formulaMan: { curMode: "liquid" } },
      { comPos: 61, comType: 6, selector: { selectedItemId: "item_solid_x" } },
      { comPos: 62, comType: 6, selector: { selectedItemId: "item_liquid_a" } },
      { comPos: 64, comType: 6, selector: { selectedItemId: "" } }, // 空串忽略
    ];
    expect(collectMixPoolSelectors(coms)).toEqual({
      solidItemId: "item_solid_x",
      fluidItemIds: ["item_liquid_a", "item_liquid_b"],
    });
    expect(collectMixPoolSelectors(undefined)).toEqual({ solidItemId: null, fluidItemIds: [] });
  });

  it("matchRecipeBySelectorSet：集合 ⊆ outputs 优先；跨配方取交集最大并标记", async () => {
    const { matchRecipeBySelectorSet } = await import(
      "@/shared/official-blueprint-import/official-config"
    );
    // 壤晶池 nodeId=1：{壤晶, 污水} 精确匹配 inert 配方（outputs=[sewage, xiranite_poly]）
    expect(
      matchRecipeBySelectorSet(registry, "mix_pool_1", ["item_xiranite_poly", "item_liquid_sewage"]),
    ).toEqual({
      recipeId: "r_chrono_mix_pool_inert_waste_liquid_water_slag_from_waste_liquid_and_iron_powder_basic",
      fullyCovered: true,
    });
    // 跨配方混合（壤晶 + lowpoly 横跨两配方）→ 交集最大 + fullyCovered=false
    const mixed = matchRecipeBySelectorSet(
      registry, "mix_pool_1", ["item_xiranite_poly", "item_liquid_xiranite_lowpoly"],
    );
    expect(mixed).not.toBeNull();
    expect(mixed!.fullyCovered).toBe(false);
    // 完全无关物品 → null
    expect(matchRecipeBySelectorSet(registry, "mix_pool_1", ["item_copper_ore"])).toBeNull();
    expect(matchRecipeBySelectorSet(registry, "mix_pool_1", [])).toBeNull();
  });

  it("转换后 mix_pool 输出端口为 item 级白名单（根除原料直通）", async () => {
    const { convertOfficialBlueprint, extractOfficialBlueprintData } = await import(
      "@/shared/official-blueprint-import"
    );
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(
      readFileSync("src/tests/fixtures/official/bp_EF0108131aE82iAIE179.json", "utf8"),
    ) as unknown;
    const { doc, report } = convertOfficialBlueprint(extractOfficialBlueprintData(raw), {
      registry,
      now: "2026-01-01T00:00:00.000Z",
      blueprintId: "test-rangjing-r1",
    });
    // 壤晶 mix_pool_1:0（nodeId=1）：selector {61:壤晶, 62:污水}
    const pool = doc.entities["mix_pool_1:0"]!;
    expect(pool.config["portGroups[0].ports[0].acceptRule"]).toEqual({
      base: { kind: "item", itemId: "item_xiranite_poly" },
      exclude: [],
    });
    expect(pool.config["portGroups[0].ports[1].acceptRule"]).toEqual({
      base: { kind: "item", itemId: "item_xiranite_poly" },
      exclude: [],
    });
    expect(pool.config["portGroups[2].ports[0].acceptRule"]).toEqual({
      base: { kind: "item", itemId: "item_liquid_sewage" },
      exclude: [],
    });
    expect(pool.config["channelRecipes"]).toEqual({
      ch1: "r_chrono_mix_pool_inert_waste_liquid_water_slag_from_waste_liquid_and_iron_powder_basic",
    });
    // 缺液警告：mix_pool_1:0 液体输入无管道连接
    expect(
      report.warnings.some(
        (w) => w.includes("mix_pool_1:0") && w.includes("液体输入端口无管道连接"),
      ),
    ).toBe(true);
  });
});
