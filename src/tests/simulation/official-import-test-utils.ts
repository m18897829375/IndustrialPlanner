import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { expect } from "vitest";

import { createRegistryContract } from "@/registry";
import { convertOfficialBlueprint } from "@/shared/official-blueprint-import";
import type {
  ConvertReport,
  OfficialBlueprintData,
} from "@/shared/official-blueprint-import";
import {
  buildExplicitEdgeTable,
  diffEdgeTables,
  edgeComparisonKey,
  extractOfficialBlueprintData,
  parseEdgeTable,
  validateEdgeEndpoints,
  type ExplicitEdge,
} from "@/shared/official-blueprint-import";

/**
 * 官方蓝图导入测试共享工具（blueprint / blueprint-slow 两个 project 复用）。
 * 阈值基线：Python convert_v5.py 转换统计 + sim-runner/reports 产出基线。
 */

export interface FixtureExpectation {
  readonly name: string;
  /**
   * 基线：实体数 / 设备数 / 物流节数 / slotLinks 数 / 连接数。
   * 注意：connectionCount 已于 2026-10-05 从 Python 基线切换为 TS 多端口实测值——
   * 游戏建筑表（FactoryBuildingTable）证实生产设备沿整边每格一个端口，
   * Python 基线少连（TS 边集为 Python 严格超集，8 份 fixture 逐边验证无遗漏）。
   */
  readonly entityCount: number;
  readonly deviceCount: number;
  readonly logisticsCount: number;
  readonly slotLinkCount: number;
  readonly connectionCount: number;
  /** Python 基线警告计数：端口接驳冲突数 / 几何接触但未连通数。 */
  readonly adaptationConflicts: number;
  readonly unconnectedWarnings: number;
  /** R1 新增警告计数：缺液警告 + 跨配方混合警告（供应缺口与 selector 混合是显式报告项）。 */
  readonly supplyOrRecipeWarnings: number;
  /** 产出断言：itemId → 最低 producedPerMinute。undefined = 不仿真（仅拓扑）。 */
  readonly produces?: Readonly<Record<string, number>>;
}

export function loadOfficialFixture(name: string): OfficialBlueprintData {
  const raw = JSON.parse(
    readFileSync(`src/tests/fixtures/official/${name}.json`, "utf8"),
  ) as unknown;
  return extractOfficialBlueprintData(raw);
}

export function convertFixture(name: string): {
  doc: ReturnType<typeof convertOfficialBlueprint>["doc"];
  report: ConvertReport;
} {
  return convertOfficialBlueprint(loadOfficialFixture(name), {
    registry: createRegistryContract(),
    now: "2026-01-01T00:00:00.000Z",
    blueprintId: `test-${name}`,
  });
}

/** 加载 fixture 边表 sidecar（不存在返回 null = 该 fixture 不参与边集断言）。 */
export function loadEdgeTableFixture(name: string): ReturnType<typeof parseEdgeTable> | null {
  const path = `src/tests/fixtures/official/${name}.edges.json`;
  if (!existsSync(path)) return null;
  return parseEdgeTable(JSON.parse(readFileSync(path, "utf8")));
}

function formatEdgeBrief(edge: ExplicitEdge): string {
  return `${edge.id} [${edge.kind}] ${edge.from.entityId}→${edge.to.entityId}`
    + ` @(${edge.from.cell.x},${edge.from.cell.y})`;
}

/** 全边集相等断言：当前转换的显式边与已提交 sidecar 逐边一致（比对键忽略边 id）。 */
export function assertEdgesMatchSidecar(name: string, report: ConvertReport): void {
  const sidecar = loadEdgeTableFixture(name);
  if (sidecar === null) return;
  const fresh = buildExplicitEdgeTable({
    edges: report.topologyCheck.connections,
    blueprintCode: name,
    sourceHash: "",
    zMax: 0,
  });
  const diff = diffEdgeTables(fresh, sidecar);
  expect(
    diff.onlyInFresh.map(formatEdgeBrief),
    `${name} 存在 sidecar 之外的新推断边（推断逻辑变更？）`,
  ).toEqual([]);
  expect(
    diff.onlyInSidecar.map(formatEdgeBrief),
    `${name} sidecar 中的推断边在新转换中消失（推断回归？）`,
  ).toEqual([]);
  const endpointIssues = validateEdgeEndpoints(diff.manual, report.topologyCheck.ports);
  expect(
    endpointIssues,
    `${name} 人工边端口不可解析:\n${endpointIssues.map((i) => `${i.edgeId}.${i.endpoint}: ${i.reason}`).join("\n")}`,
  ).toEqual([]);
  // 数量一致性双保险（边集断言为主，数量断言兜住 id 重排类意外）
  expect(
    new Set(report.topologyCheck.connections.map(edgeComparisonKey)).size,
    `${name} 存在重复比对键的边`,
  ).toBe(report.topologyCheck.connections.length);
}

export function assertConversionMatchesBaseline(
  expectation: FixtureExpectation,
  report: ConvertReport,
): void {
  expect(report.skipped, `${expectation.name} 存在跳过项`).toEqual([]);
  expect(report.entityCount).toBe(expectation.entityCount);
  expect(report.deviceCount).toBe(expectation.deviceCount);
  expect(report.logisticsCount).toBe(expectation.logisticsCount);
  expect(report.slotLinkCount).toBe(expectation.slotLinkCount);
  expect(
    report.topologyCheck.connectionCount,
    `${expectation.name} 连接数与基线不符（基线 = TS 多端口实测值，游戏建筑表校准）`,
  ).toBe(expectation.connectionCount);
  assertEdgesMatchSidecar(expectation.name, report);
  // 警告分类计数与基线逐一相等（接驳冲突 / 几何未连通为已知基线产物；缺液 / 跨配方为 R1 显式报告项）
  const adaptationConflicts = report.warnings.filter((w) => w.includes("端口接驳冲突"));
  const unconnected = report.topologyCheck.unconnectedPortWarnings;
  const supplyOrRecipe = report.warnings.filter(
    (w) => w.includes("液体输入端口无管道连接") || w.includes("跨配方混合") || w.includes("无匹配配方"),
  );
  const knownPatterns = ["端口接驳冲突", "几何接触但未连通", "液体输入端口无管道连接", "跨配方混合", "无匹配配方"];
  const others = report.warnings.filter(
    (w) => !knownPatterns.some((pattern) => w.includes(pattern)),
  );
  expect(
    adaptationConflicts.length,
    `${expectation.name} 接驳冲突数不符:\n${adaptationConflicts.join("\n")}`,
  ).toBe(expectation.adaptationConflicts);
  expect(
    unconnected.length,
    `${expectation.name} 几何未连通警告数不符:\n${unconnected.join("\n")}`,
  ).toBe(expectation.unconnectedWarnings);
  expect(
    supplyOrRecipe.length,
    `${expectation.name} 缺液/配方警告数不符:\n${supplyOrRecipe.join("\n")}`,
  ).toBe(expectation.supplyOrRecipeWarnings);
  expect(
    others,
    `${expectation.name} 存在意外警告:\n${others.join("\n")}`,
  ).toEqual([]);
}
