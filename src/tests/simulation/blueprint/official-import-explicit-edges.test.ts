import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createRegistryContract } from "@/registry";
import {
  convertOfficialBlueprint,
  extractOfficialBlueprintData,
  type ExplicitEdgeTable,
} from "@/shared/official-blueprint-import";
import { compileSimulationTopology } from "@/simulation/topology";
import type { WorldDocument } from "@/domain/document/world-document";
import { createWorldDocumentFromBlueprint } from "../blueprint-test-helpers";
import { convertFixture, loadEdgeTableFixture } from "../official-import-test-utils";

/**
 * Phase B 集成测试：仿真编译真实消费显式边表。
 *
 * - 零漂移：内嵌边表 == 纯推断时，编译结果与无边表逐条相等；
 * - 禁边：sidecar disabled 的边从编译拓扑中消失（info 留痕）；
 * - 回退：边表与实体大面积失配时整体回退几何推断 + error 诊断。
 */

const FIXTURE = "bp_EF01I43ouo3OA979O5o08";

function compileWorld(document: WorldDocument) {
  return compileSimulationTopology({
    document,
    registry: createRegistryContract(),
    simulationMode: "single-base",
    poweredEntityIds: new Set(document.entityOrder),
  });
}

describe("显式边表 → 仿真编译（Phase B）", () => {
  it("零漂移：内嵌边表与纯几何推断的编译结果逐条相等", () => {
    const { doc } = convertFixture(FIXTURE);
    expect(doc.logisticsEdges, "导入应内嵌显式边表").toBeDefined();
    expect(doc.logisticsEdges!.edges.length).toBeGreaterThan(0);

    const withEdges = compileWorld(createWorldDocumentFromBlueprint(doc));
    const stripped: WorldDocument = { ...createWorldDocumentFromBlueprint(doc) };
    delete stripped.logisticsEdges;
    const withoutEdges = compileWorld(stripped);

    expect(Object.keys(withEdges.physicalConnections).sort())
      .toEqual(Object.keys(withoutEdges.physicalConnections).sort());
    expect(withEdges.ordering.physicalConnectionOrder)
      .toEqual(withoutEdges.ordering.physicalConnectionOrder);
    expect(Object.keys(withEdges.transferEdges).sort())
      .toEqual(Object.keys(withoutEdges.transferEdges).sort());
    // 边表与推断一致时不应产生 omitted 诊断
    expect(withEdges.diagnostics.filter((d) => d.code === "explicit-edge-omitted")).toEqual([]);
    expect(withEdges.diagnostics.filter((d) => d.code === "unresolved-explicit-edge")).toEqual([]);
    // topologyId 为内容哈希：连接内容一致 → topologyId 一致（documentHash 不含边表差异，
    // 因为边表本身就是文档内容的一部分，两文档本就该视为不同输入）
  });

  it("禁边生效：sidecar disabled 的边从编译拓扑中消失", () => {
    const sidecar = loadEdgeTableFixture(FIXTURE);
    expect(sidecar, "fixture 边表 sidecar 应已提交").not.toBeNull();

    // 基线：无 sidecar 的编译（内嵌边表 = 纯推断）
    const baselineTopology = compileWorld(
      createWorldDocumentFromBlueprint(convertFixture(FIXTURE).doc),
    );
    const baselineConnectionIds = Object.keys(baselineTopology.physicalConnections);

    const disabledId = sidecar!.edges[0]!.id;
    const modified: ExplicitEdgeTable = { ...sidecar!, disabled: [disabledId] };
    const raw = JSON.parse(
      readFileSync(`src/tests/fixtures/official/${FIXTURE}.json`, "utf8"),
    ) as unknown;
    const { doc } = convertOfficialBlueprint(extractOfficialBlueprintData(raw), {
      registry: createRegistryContract(),
      now: "2026-01-01T00:00:00.000Z",
      blueprintId: `test-${FIXTURE}`,
      edgeSidecar: modified,
    });

    // 合并后内嵌边表少一条
    expect(doc.logisticsEdges!.edges.length).toBe(sidecar!.edges.length - 1);

    const topology = compileWorld(createWorldDocumentFromBlueprint(doc));
    const connectionIds = Object.keys(topology.physicalConnections);
    expect(connectionIds.length).toBe(baselineConnectionIds.length - 1);
    const missing = baselineConnectionIds.filter((id) => !connectionIds.includes(id));
    expect(missing).toHaveLength(1);
    expect(
      topology.diagnostics.some(
        (d) => d.code === "explicit-edge-omitted" && d.message.includes(missing[0]!),
      ),
      "被禁边应有 info 留痕",
    ).toBe(true);
    expect(topology.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("整体回退：边表与实体大面积失配（ID 漂移）→ 几何推断兜底 + error 诊断", () => {
    const { doc } = convertFixture(FIXTURE);
    const ghostTable: ExplicitEdgeTable = {
      ...doc.logisticsEdges!,
      edges: doc.logisticsEdges!.edges.map((edge) => ({
        ...edge,
        from: { ...edge.from, entityId: `ghost:${edge.from.entityId}` },
        to: { ...edge.to, entityId: `ghost:${edge.to.entityId}` },
      })),
    };
    const world: WorldDocument = {
      ...createWorldDocumentFromBlueprint(doc),
      logisticsEdges: ghostTable,
    };
    const topology = compileWorld(world);

    expect(
      topology.diagnostics.some((d) => d.code === "stale-explicit-edge-table" && d.severity === "error"),
      "应报边表过期诊断",
    ).toBe(true);
    // 回退后连接数 = 纯几何推断数（与内嵌推断边数一致）
    expect(Object.keys(topology.physicalConnections).length)
      .toBe(doc.logisticsEdges!.edges.length);
  });
});
