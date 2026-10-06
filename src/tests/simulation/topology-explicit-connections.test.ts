import { describe, expect, it } from "vitest";

import type { ExplicitEdge } from "@/domain/document/explicit-edges";
import type {
  CompiledSimulationDevice,
  CompiledSimulationPhysicalConnection,
  CompiledSimulationPort,
  SimulationCompileDiagnostic,
} from "@/simulation/contracts";
import { reconcileExplicitConnections } from "@/simulation/topology";

/**
 * reconcileExplicitConnections 单测：合成编译期端口/设备，精确控制几何推断结果，
 * 验证显式边表的四种调和语义（过滤/追加/逐条诊断/整体回退）与零漂移。
 */

function makePort(
  entityId: string,
  group: string,
  portId: string,
  direction: "input" | "output",
  isPipe: boolean,
  inside: { x: number; y: number },
  outside: { x: number; y: number },
): CompiledSimulationPort {
  return {
    id: `device:${entityId}/port:${group}.${portId}.${direction}`,
    deviceId: `device:${entityId}`,
    direction,
    isPipe,
    insideGridPoint: inside,
    outsideGridPoint: outside,
  } as unknown as CompiledSimulationPort;
}

function makeDevice(entityId: string, definitionId: string): CompiledSimulationDevice {
  return { id: `device:${entityId}`, definitionId } as unknown as CompiledSimulationDevice;
}

function makeEdge(
  id: string,
  kind: "belt" | "pipe",
  fromEntity: string, fromGroup: string, fromPort: string,
  toEntity: string, toGroup: string, toPort: string,
  provenance: "inferred" | "manual" = "inferred",
): ExplicitEdge {
  return {
    id,
    kind,
    from: {
      entityId: fromEntity,
      port: { group: fromGroup, id: fromPort, direction: "output" },
      cell: { x: 0, y: 0 }, outside: { x: 0, y: 0 },
    },
    to: {
      entityId: toEntity,
      port: { group: toGroup, id: toPort, direction: "input" },
      cell: { x: 0, y: 0 }, outside: { x: 0, y: 0 },
    },
    provenance,
  };
}

function makeGeoConnection(sourcePort: CompiledSimulationPort, targetPort: CompiledSimulationPort): CompiledSimulationPhysicalConnection {
  return {
    id: `connection:${sourcePort.id}->${targetPort.id}`,
    sourcePortId: sourcePort.id,
    targetPortId: targetPort.id,
    sourceInsideGridPoint: sourcePort.insideGridPoint,
    targetInsideGridPoint: targetPort.insideGridPoint,
  };
}

// 场景：A(设备，输出) → B(带节) → C(设备，输入)；另备 D(带节) 与 A 相邻但几何未连
const A_OUT = makePort("furnance_1:0", "item_output", "out_e", "output", false, { x: 3, y: 5 }, { x: 4, y: 5 });
const B_IN = makePort("belt:1", "item_input", "in_w", "input", false, { x: 4, y: 5 }, { x: 3, y: 5 });
const B_OUT = makePort("belt:1", "item_output", "out_e", "output", false, { x: 4, y: 5 }, { x: 5, y: 5 });
const C_IN = makePort("loader_1:0", "item_input", "in_w", "input", false, { x: 5, y: 5 }, { x: 4, y: 5 });
// D 与 A 几何相邻（互为内外侧），但几何推断未连（模拟推断歧义场景）
const D_IN = makePort("belt:2", "item_input", "in_s", "input", false, { x: 3, y: 6 }, { x: 3, y: 5 });
const A_OUT_S = makePort("furnance_1:0", "item_output", "out_s", "output", false, { x: 3, y: 5 }, { x: 3, y: 6 });

const PORTS: Record<string, CompiledSimulationPort> = Object.fromEntries(
  [A_OUT, B_IN, B_OUT, C_IN, D_IN, A_OUT_S].map((p) => [p.id, p]),
);
const DEVICES: Record<string, CompiledSimulationDevice> = Object.fromEntries(
  [
    makeDevice("furnance_1:0", "furnance_1"),
    makeDevice("belt:1", "belt_straight_1x1"),
    makeDevice("belt:2", "belt_straight_1x1"),
    makeDevice("loader_1:0", "loader_1"),
  ].map((d) => [d.id, d]),
);
const isGeneralLogistics = (definitionId: string): boolean => definitionId.startsWith("belt_");

const EDGE_AB = makeEdge("e0001", "belt", "furnance_1:0", "item_output", "out_e", "belt:1", "item_input", "in_w");
const EDGE_BC = makeEdge("e0002", "belt", "belt:1", "item_output", "out_e", "loader_1:0", "item_input", "in_w");
const GEO_AB = makeGeoConnection(A_OUT, B_IN);
const GEO_BC = makeGeoConnection(B_OUT, C_IN);

describe("reconcileExplicitConnections", () => {
  it("零漂移：边表 == 推断结果时输出与纯几何编译逐条相等", () => {
    const diagnostics: SimulationCompileDiagnostic[] = [];
    const result = reconcileExplicitConnections(
      [EDGE_AB, EDGE_BC], [GEO_AB, GEO_BC], PORTS, DEVICES, isGeneralLogistics, diagnostics,
    );
    expect(result).toEqual([GEO_AB, GEO_BC]);
    expect(diagnostics).toEqual([]);
  });

  it("缺边=不连：边表省略的几何边被剔除并留 info 诊断", () => {
    const diagnostics: SimulationCompileDiagnostic[] = [];
    const result = reconcileExplicitConnections(
      [EDGE_AB], [GEO_AB, GEO_BC], PORTS, DEVICES, isGeneralLogistics, diagnostics,
    );
    expect(result).toEqual([GEO_AB]);
    expect(diagnostics.filter((d) => d.code === "explicit-edge-omitted")).toHaveLength(1);
  });

  it("manual 边追加：几何推断不出但满足平台约束的人工边被采纳", () => {
    const manualEdge = makeEdge("m0001", "belt", "furnance_1:0", "item_output", "out_s", "belt:2", "item_input", "in_s", "manual");
    const diagnostics: SimulationCompileDiagnostic[] = [];
    const result = reconcileExplicitConnections(
      [EDGE_AB, EDGE_BC, manualEdge], [GEO_AB, GEO_BC], PORTS, DEVICES, isGeneralLogistics, diagnostics,
    );
    expect(result).toHaveLength(3);
    expect(result[2]!.sourcePortId).toBe(A_OUT_S.id);
    expect(result[2]!.targetPortId).toBe(D_IN.id);
    expect(diagnostics).toEqual([]);
  });

  it("manual 边违反平台规则（双非物流直连/管道类型不符/几何不相邻）→ error 且跳过", () => {
    // 双非物流直连：furnance(输出) → loader(输入)，但几何不相邻会先命中相邻校验；
    // 故用"管道类型不符"与"双非物流直连"分别构造
    const wrongKind = makeEdge("m0002", "pipe", "furnance_1:0", "item_output", "out_s", "belt:2", "item_input", "in_s", "manual");
    const diagnostics: SimulationCompileDiagnostic[] = [];
    const result = reconcileExplicitConnections(
      [wrongKind], [], PORTS, DEVICES, isGeneralLogistics, diagnostics,
    );
    expect(result).toEqual([]);
    expect(diagnostics.some((d) => d.code === "unsupported-explicit-edge" && d.severity === "error")).toBe(true);
  });

  it("双非物流设备直连被拦截", () => {
    // furnance out_s → loader in_w 假相邻不可行（端口几何固定），改测直连规则：
    // 直接把 DEVICES 里 belt:2 换成非物流定义，使 A_OUT_S → D_IN 变为双非物流直连
    const strictDevices: Record<string, CompiledSimulationDevice> = {
      ...DEVICES,
      "device:belt:2": makeDevice("belt:2", "furnance_1"),
    };
    const manualEdge = makeEdge("m0003", "belt", "furnance_1:0", "item_output", "out_s", "belt:2", "item_input", "in_s", "manual");
    const diagnostics: SimulationCompileDiagnostic[] = [];
    const result = reconcileExplicitConnections(
      [manualEdge], [], PORTS, strictDevices, isGeneralLogistics, diagnostics,
    );
    expect(result).toEqual([]);
    expect(diagnostics.some((d) => d.message.includes("双非物流设备不直连"))).toBe(true);
  });

  it("整体回退：>50% 端点不可解析（ID 漂移）→ 回退几何推断 + error 诊断", () => {
    const ghostEdge = makeEdge("e0001", "belt", "ghost:0", "item_output", "out_e", "belt:1", "item_input", "in_w");
    const diagnostics: SimulationCompileDiagnostic[] = [];
    const result = reconcileExplicitConnections(
      [ghostEdge, EDGE_BC, EDGE_AB], [GEO_AB, GEO_BC], PORTS, DEVICES, isGeneralLogistics, diagnostics,
    );
    // 1/3 不可解析未超阈值 → 逐条诊断 + 剩余两条生效
    expect(result).toEqual([GEO_AB, GEO_BC]);
    expect(diagnostics.some((d) => d.code === "unresolved-explicit-edge")).toBe(true);

    const ghost2 = makeEdge("e0004", "belt", "ghost:1", "item_output", "out_e", "ghost:2", "item_input", "in_w");
    const staleDiagnostics: SimulationCompileDiagnostic[] = [];
    const staleResult = reconcileExplicitConnections(
      [ghostEdge, ghost2], [GEO_AB, GEO_BC], PORTS, DEVICES, isGeneralLogistics, staleDiagnostics,
    );
    // 2/2 不可解析超阈值 → 整体回退
    expect(staleResult).toEqual([GEO_AB, GEO_BC]);
    expect(staleDiagnostics.some((d) => d.code === "stale-explicit-edge-table" && d.severity === "error")).toBe(true);
  });
});
