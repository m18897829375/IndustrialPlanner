import { describe, expect, it } from "vitest";

import {
  buildExplicitEdgeTable,
  buildImportEdges,
  diffEdgeTables,
  EDGE_TABLE_FORMAT,
  endpointPortId,
  parseEdgeTable,
  validateEdgeEndpoints,
  type EdgeSourcePort,
  type ExplicitEdge,
} from "@/shared/official-blueprint-import";
import type { CompiledSimulationPhysicalConnection } from "@/simulation/contracts/types";

/** 造端口：id = `${eid}/${group}/${port}:${direction}`（与 topology-check 的 ID 空间一致）。 */
function makePort(
  entityId: string,
  group: string,
  portId: string,
  direction: "input" | "output",
  isPipe: boolean,
  inside: { x: number; y: number },
  outside: { x: number; y: number },
): EdgeSourcePort {
  return {
    id: `${entityId}/${group}/${portId}:${direction}`,
    deviceId: entityId,
    direction,
    isPipe,
    insideGridPoint: inside,
    outsideGridPoint: outside,
  };
}

function makeConnection(sourcePortId: string, targetPortId: string): CompiledSimulationPhysicalConnection {
  return {
    id: `connection:${sourcePortId}->${targetPortId}`,
    sourcePortId,
    targetPortId,
    sourceInsideGridPoint: { x: 0, y: 0 },
    targetInsideGridPoint: { x: 0, y: 0 },
  };
}

// 设备 A 输出 → 带节 B 输入（几何：A 外侧 = B 内侧）
const PORT_A_OUT = makePort("furnance_1:0", "item_output", "out_e", "output", false, { x: 3, y: 5 }, { x: 4, y: 5 });
const PORT_B_IN = makePort("logistics-draft:belt:4:5", "item_input", "in_w", "input", false, { x: 4, y: 5 }, { x: 3, y: 5 });
const PORT_B_OUT = makePort("logistics-draft:belt:4:5", "item_output", "out_e", "output", false, { x: 4, y: 5 }, { x: 5, y: 5 });
const PORT_C_IN = makePort("loader_1:0", "item_input", "in_w_1", "input", false, { x: 5, y: 5 }, { x: 4, y: 5 });

const ALL_PORTS: readonly EdgeSourcePort[] = [PORT_A_OUT, PORT_B_IN, PORT_B_OUT, PORT_C_IN];

const CONNECTIONS: readonly CompiledSimulationPhysicalConnection[] = [
  makeConnection(PORT_A_OUT.id, PORT_B_IN.id),
  makeConnection(PORT_B_OUT.id, PORT_C_IN.id),
];

describe("official-edge-table", () => {
  it("buildImportEdges: 连接 → 显式边（端口双标识 + 确定性排序与 id）", () => {
    const edges = buildImportEdges(CONNECTIONS, ALL_PORTS);
    expect(edges).toHaveLength(2);
    // 排序按 comparison key：furnance 边在 loader 边之前
    const [e1, e2] = edges;
    expect(e1!.id).toBe("e0001");
    expect(e2!.id).toBe("e0002");
    expect(e1!.kind).toBe("belt");
    expect(e1!.provenance).toBe("inferred");
    expect(e1!.from.entityId).toBe("furnance_1:0");
    expect(e1!.from.port).toEqual({ group: "item_output", id: "out_e", direction: "output" });
    expect(e1!.from.cell).toEqual({ x: 3, y: 5 });
    expect(e1!.from.outside).toEqual({ x: 4, y: 5 });
    expect(e1!.to.entityId).toBe("logistics-draft:belt:4:5");
    expect(endpointPortId(e1!.from)).toBe(PORT_A_OUT.id);
    // 重跑幂等：同输入同 id
    const rerun = buildImportEdges(CONNECTIONS, ALL_PORTS);
    expect(rerun).toEqual(edges);
  });

  it("buildImportEdges: 端口缺失时跳过该边（不静默造错边）", () => {
    const dangling = makeConnection("ghost:0/g/p:output", PORT_B_IN.id);
    expect(buildImportEdges([dangling], ALL_PORTS)).toEqual([]);
  });

  it("round-trip: buildExplicitEdgeTable → JSON → parseEdgeTable", () => {
    const edges = buildImportEdges(CONNECTIONS, ALL_PORTS);
    const table = buildExplicitEdgeTable({
      edges, blueprintCode: "EF01TEST", sourceHash: "sha256:abc", zMax: 42,
    });
    expect(table.format).toBe(EDGE_TABLE_FORMAT);
    const restored = parseEdgeTable(JSON.parse(JSON.stringify(table)));
    expect(restored).toEqual(table);
  });

  it("parseEdgeTable: 格式非法时显式抛错", () => {
    expect(() => parseEdgeTable(null)).toThrow("边表不是对象");
    expect(() => parseEdgeTable({ format: "wrong" })).toThrow("format 不符");
    expect(() => parseEdgeTable({ format: EDGE_TABLE_FORMAT, blueprintCode: 1 })).toThrow("blueprintCode");
    expect(() => parseEdgeTable({
      format: EDGE_TABLE_FORMAT, blueprintCode: "X", sourceHash: "s", edges: [{ id: 1 }], disabled: [],
    })).toThrow("边格式非法");
  });

  it("diffEdgeTables: 相同集合零差异", () => {
    const edges = buildImportEdges(CONNECTIONS, ALL_PORTS);
    const a = buildExplicitEdgeTable({ edges, blueprintCode: "X", sourceHash: "s", zMax: 1 });
    const b = buildExplicitEdgeTable({ edges, blueprintCode: "X", sourceHash: "s", zMax: 1 });
    const diff = diffEdgeTables(a, b);
    expect(diff.onlyInFresh).toEqual([]);
    expect(diff.onlyInSidecar).toEqual([]);
    expect(diff.manual).toEqual([]);
  });

  it("diffEdgeTables: manual 边不参与几何比对，disabled 从推断集中摘除", () => {
    const freshEdges = buildImportEdges(CONNECTIONS, ALL_PORTS);
    const fresh = buildExplicitEdgeTable({ edges: freshEdges, blueprintCode: "X", sourceHash: "s", zMax: 1 });

    // sidecar：禁用 e0002 + 一条 manual 新边（几何上 fresh 没有）
    const manualEdge: ExplicitEdge = {
      id: "m0001",
      kind: "belt",
      from: { entityId: "furnance_1:0", port: { group: "item_output", id: "out_e", direction: "output" }, cell: { x: 3, y: 5 }, outside: { x: 4, y: 5 } },
      to: { entityId: "loader_1:0", port: { group: "item_input", id: "in_w_1", direction: "input" }, cell: { x: 5, y: 5 }, outside: { x: 4, y: 5 } },
      provenance: "manual",
    };
    const sidecar = buildExplicitEdgeTable({
      edges: [...freshEdges, manualEdge],
      blueprintCode: "X", sourceHash: "s", zMax: 1,
      disabled: ["e0002"],
    });

    const diff = diffEdgeTables(fresh, sidecar);
    // e0002 被禁用 → sidecar 推断集缺它 → 出现在 onlyInFresh（提示"推断有、边表禁用"由 disabled 列表承担）
    expect(diff.onlyInFresh.map((e) => e.id)).toEqual(["e0002"]);
    expect(diff.onlyInSidecar).toEqual([]);
    expect(diff.manual.map((e) => e.id)).toEqual(["m0001"]);
    expect(diff.disabled).toEqual(["e0002"]);
  });

  it("validateEdgeEndpoints: 可解析性 + 方向/isPipe 冲突检测", () => {
    const edges = buildImportEdges(CONNECTIONS, ALL_PORTS);
    expect(validateEdgeEndpoints(edges, ALL_PORTS)).toEqual([]);

    const ghostEdge: ExplicitEdge = {
      ...edges[0]!,
      id: "m0001",
      provenance: "manual",
      to: { ...edges[0]!.to, entityId: "ghost:0" },
    };
    const issues = validateEdgeEndpoints([ghostEdge], ALL_PORTS);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.endpoint).toBe("to");
    expect(issues[0]!.reason).toContain("端口不存在");

    const wrongKind: ExplicitEdge = { ...edges[0]!, id: "m0002", kind: "pipe", provenance: "manual" };
    const kindIssues = validateEdgeEndpoints([wrongKind], ALL_PORTS);
    expect(kindIssues.some((i) => i.reason.includes("isPipe 冲突"))).toBe(true);
  });
});
