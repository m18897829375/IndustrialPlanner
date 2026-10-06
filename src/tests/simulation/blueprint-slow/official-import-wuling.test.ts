import { describe, expect, it } from "vitest";

import { createRegistryContract } from "@/registry";
import { runBlueprintSimulation } from "../blueprint-runner";
import {
  assertConversionMatchesBaseline,
  convertFixture,
  type FixtureExpectation,
} from "../official-import-test-utils";

/**
 * 官方蓝图导入端到端验证：武陵大蓝图（blueprint-slow project，testTimeout 1800s）。
 * 367-467 实体 × 150s 仿真（20tps ≈ 3000 ticks）墙钟超出 blueprint project 的 120s。
 */

const WULING_EXPECTATIONS: readonly FixtureExpectation[] = [
  {
    // 武陵1 全液体链（10 台 furnance_1_liquid 依赖管准入口供酸）：平台语义下
    // 管准入口不主动从仓库取液 → 不产铜锭（Python 基线来自不同运行环境）。
    // 仅断言转换对齐 + 拓扑。
    name: "bp_EF013Eou8uo47auUu0579", // 武陵1
    entityCount: 367, deviceCount: 53, logisticsCount: 314, slotLinkCount: 10, connectionCount: 361,
    adaptationConflicts: 0, unconnectedWarnings: 2,
    supplyOrRecipeWarnings: 0,
  },
  {
    name: "bp_EF0170iUeUi6855u2O0Ai", // 武陵3
    entityCount: 461, deviceCount: 79, logisticsCount: 382, slotLinkCount: 12, connectionCount: 454,
    adaptationConflicts: 0, unconnectedWarnings: 24,
    supplyOrRecipeWarnings: 3,
    // 采种机固体链（unloader 供应 → seedcol_1），Python 基线 30/min
    produces: { item_plant_grass_seed_2: 1 },
  },
  {
    // 2026-10-05 基线修正：连接数 333 / 未连通 48（原记录 327/54）。
    // 两层偏差叠加：(a) TS 版修复了 Python 的 `or` 吞 0 bug（infer_single_cell_dir
    // 返回 0=E 流被 `or` 短路为 fallback）；(b) 多端口设备（thickener/tools_asm_mc 等
    // 沿整边每格一个端口，游戏建筑表 FactoryBuildingTable 实证）几何接触即连通，
    // Python 基线少连。TS 边集为 Python 严格超集，逐边 diff 无遗漏。
    name: "bp_EF010819a91uOi12iE179", // 武陵4
    entityCount: 376, deviceCount: 60, logisticsCount: 316, slotLinkCount: 22, connectionCount: 333,
    adaptationConflicts: 0, unconnectedWarnings: 48,
    supplyOrRecipeWarnings: 0,
    produces: { item_originium_powder: 1 }, // Python 基线 480/min
  },
];

describe("官方蓝图导入 → 仿真端到端验证（武陵大蓝图）", () => {
  for (const expectation of WULING_EXPECTATIONS) {
    it(
      `${expectation.name}: 转换对齐 Python 基线，150s 仿真产出达标`,
      { timeout: 1_800_000 },
      async () => {
        const { doc, report } = convertFixture(expectation.name);
        assertConversionMatchesBaseline(expectation, report);

        const simulation = await runBlueprintSimulation({
          blueprint: doc,
          maxDurationSeconds: 150,
          registry: createRegistryContract(),
        });

        const errorDiagnostics = simulation.topology.diagnostics.filter(
          (diagnostic) => diagnostic.severity === "error",
        );
        expect(
          errorDiagnostics,
          `${expectation.name} 拓扑 error 诊断:\n`
          + errorDiagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
        ).toEqual([]);

        const finalTick = simulation.ticks.at(-1);
        const warehouseStats = finalTick?.warehouseStats;
        expect(warehouseStats).not.toBeNull();
        for (const [itemId, minPerMinute] of Object.entries(expectation.produces ?? {})) {
          const stats = warehouseStats!.items[itemId];
          expect(
            stats?.producedPerMinute ?? 0,
            `${expectation.name} ${itemId} producedPerMinute=${stats?.producedPerMinute ?? 0} < ${minPerMinute}`,
          ).toBeGreaterThanOrEqual(minPerMinute);
        }
      },
    );
  }
});
