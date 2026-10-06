import {
  EDGE_TABLE_FORMAT,
  type EdgeEndpointRef,
  type EdgePortDirection,
  type ExplicitEdge,
  type ExplicitEdgeTable,
} from "@/domain/document/explicit-edges";
import type { GridPoint } from "@/domain/shared/grid";
import type { CompiledSimulationPhysicalConnection } from "@/simulation/contracts/types";

// 类型再导出：调用方只需从本模块（或 shared/official-blueprint-import 桶）取类型。
export {
  EDGE_TABLE_FORMAT,
  type EdgeEndpointRef,
  type EdgePortDirection,
  type ExplicitEdge,
  type ExplicitEdgeTable,
};

/**
 * 显式边表构建/diff/校验逻辑（构建侧）。
 *
 * 边表不创造信息——它由与游戏同款的几何推断产生（游戏保存蓝图时丢弃
 * 运行时连接边，拍蓝图时按几何重建），推断错误会原样写入。价值在于把
 * 隐式推断冻结成可 diff、可审查、可人工覆盖（provenance:"manual" /
 * disabled）的显式工件。
 */

/**
 * 生成侧端口结构化子集（与 official-topology-check 的 MinimalPort 对齐）。
 * 端口 ID 空间：`${entityId}/${portGroupId}/${portId}:${direction}`。
 */
export interface EdgeSourcePort {
  readonly id: string;
  readonly deviceId: string;
  readonly direction: EdgePortDirection;
  readonly isPipe: boolean;
  readonly insideGridPoint: GridPoint;
  readonly outsideGridPoint: GridPoint;
}

/** 解析拓扑自检端口 ID（`${eid}/${group}/${port}:${direction}`；eid/group/port 均不含 "/"）。 */
function parsePortId(portId: string): { entityId: string; group: string; port: string; direction: EdgePortDirection } | null {
  const directionSplit = portId.lastIndexOf(":");
  if (directionSplit < 0) return null;
  const direction = portId.slice(directionSplit + 1);
  if (direction !== "input" && direction !== "output") return null;
  const parts = portId.slice(0, directionSplit).split("/");
  if (parts.length !== 3) return null;
  const [entityId, group, port] = parts;
  if (!entityId || !group || !port) return null;
  return { entityId, group, port, direction };
}

/** 端口引用 → 生成侧端口 ID（与 parsePortId 互逆）。 */
export function endpointPortId(endpoint: EdgeEndpointRef): string {
  return `${endpoint.entityId}/${endpoint.port.group}/${endpoint.port.id}:${endpoint.port.direction}`;
}

/**
 * 从平台 compilePhysicalConnections 结果构建显式边。
 * connection.source = output 侧端口，target = input 侧端口（compiler 语义）。
 * 输出按 (kind, from 格, to 格, 端口 ID) 确定性排序后分配 e0001… 序号。
 */
export function buildImportEdges(
  connections: readonly CompiledSimulationPhysicalConnection[],
  ports: readonly EdgeSourcePort[],
): ExplicitEdge[] {
  const portsById = new Map(ports.map((port) => [port.id, port]));
  const edges: ExplicitEdge[] = [];
  for (const connection of connections) {
    const sourcePort = portsById.get(connection.sourcePortId);
    const targetPort = portsById.get(connection.targetPortId);
    const sourceRef = parsePortId(connection.sourcePortId);
    const targetRef = parsePortId(connection.targetPortId);
    if (sourcePort === undefined || targetPort === undefined || sourceRef === null || targetRef === null) {
      continue; // 端口不可解析 = 上游装配错误，由 topologyCheck 警告兜底，不静默造边
    }
    edges.push({
      id: "", // 排序后统一分配
      kind: sourcePort.isPipe ? "pipe" : "belt",
      from: {
        entityId: sourceRef.entityId,
        port: { group: sourceRef.group, id: sourceRef.port, direction: sourceRef.direction },
        cell: sourcePort.insideGridPoint,
        outside: sourcePort.outsideGridPoint,
      },
      to: {
        entityId: targetRef.entityId,
        port: { group: targetRef.group, id: targetRef.port, direction: targetRef.direction },
        cell: targetPort.insideGridPoint,
        outside: targetPort.outsideGridPoint,
      },
      provenance: "inferred",
    });
  }
  edges.sort((a, b) => edgeComparisonKey(a).localeCompare(edgeComparisonKey(b)));
  return edges.map((edge, index) => ({ ...edge, id: `e${String(index + 1).padStart(4, "0")}` }));
}

/** 比对键：忽略边 id 与 provenance，按 类型+两端点（entity/端口/几何） 归一。 */
export function edgeComparisonKey(edge: ExplicitEdge): string {
  return [edge.kind, endpointKey(edge.from), endpointKey(edge.to)].join("|");
}

function endpointKey(endpoint: EdgeEndpointRef): string {
  return `${endpointPortId(endpoint)}@${endpoint.cell.x},${endpoint.cell.y}>${endpoint.outside.x},${endpoint.outside.y}`;
}

/** 组装 sidecar 封套。 */
export function buildExplicitEdgeTable(options: {
  readonly edges: readonly ExplicitEdge[];
  readonly blueprintCode: string;
  readonly sourceHash: string;
  readonly zMax: number;
  readonly disabled?: readonly string[];
}): ExplicitEdgeTable {
  return {
    format: EDGE_TABLE_FORMAT,
    blueprintCode: options.blueprintCode,
    sourceHash: options.sourceHash,
    grid: { zMax: options.zMax },
    edges: options.edges,
    disabled: options.disabled ?? [],
  };
}

export interface EdgeTableDiff {
  /** 新推断有、sidecar 没有（推断逻辑变更或 sidecar 过期）。 */
  readonly onlyInFresh: readonly ExplicitEdge[];
  /** sidecar 的 inferred 边在新推断中消失（推断回归信号）。 */
  readonly onlyInSidecar: readonly ExplicitEdge[];
  /** sidecar 中的人工边（不与推断比对"几何不一致"，由 validateEdgeEndpoints 校验）。 */
  readonly manual: readonly ExplicitEdge[];
  /** sidecar 禁用的推断边 id。 */
  readonly disabled: readonly string[];
}

/**
 * fresh（新推断）vs sidecar（已有人工修正）对称差。
 * sidecar 先应用 disabled（按 id 移除推断边），manual 边整体摘出不参与比对。
 */
export function diffEdgeTables(fresh: ExplicitEdgeTable, sidecar: ExplicitEdgeTable): EdgeTableDiff {
  const disabledSet = new Set(sidecar.disabled);
  const sidecarInferred = sidecar.edges.filter(
    (edge) => edge.provenance !== "manual" && !disabledSet.has(edge.id),
  );
  const sidecarManual = sidecar.edges.filter((edge) => edge.provenance === "manual");

  const freshKeys = new Map(fresh.edges.map((edge) => [edgeComparisonKey(edge), edge]));
  const sidecarKeys = new Map(sidecarInferred.map((edge) => [edgeComparisonKey(edge), edge]));

  const onlyInFresh = fresh.edges.filter((edge) => !sidecarKeys.has(edgeComparisonKey(edge)));
  const onlyInSidecar = sidecarInferred.filter((edge) => !freshKeys.has(edgeComparisonKey(edge)));
  return {
    onlyInFresh,
    onlyInSidecar,
    manual: sidecarManual,
    disabled: [...disabledSet],
  };
}

export interface EdgeEndpointIssue {
  readonly edgeId: string;
  readonly endpoint: "from" | "to";
  readonly reason: string;
}

/**
 * 合并推断边与人工 sidecar，产出最终生效边集：
 * - sidecar.disabled 按 id 引用 sidecar 内的推断边 → 按比对键从推断集中移除；
 * - sidecar 中 provenance=manual 的边整体追加（id 保持，调用方需保证唯一）；
 * - 推断边顺序与 id 不变（保持确定性）。
 */
export function applyEdgeSidecar(
  inferred: readonly ExplicitEdge[],
  sidecar: Pick<ExplicitEdgeTable, "edges" | "disabled">,
): ExplicitEdge[] {
  const disabledSet = new Set(sidecar.disabled);
  const disabledKeys = new Set(
    sidecar.edges
      .filter((edge) => edge.provenance !== "manual" && disabledSet.has(edge.id))
      .map(edgeComparisonKey),
  );
  const manual = sidecar.edges.filter((edge) => edge.provenance === "manual");
  return [
    ...inferred.filter((edge) => !disabledKeys.has(edgeComparisonKey(edge))),
    ...manual,
  ];
}

/** 校验边端点在当前端口集合中可解析（manual 边的主要校验手段）。 */
export function validateEdgeEndpoints(
  edges: readonly ExplicitEdge[],
  ports: readonly EdgeSourcePort[],
): EdgeEndpointIssue[] {
  const portsById = new Map(ports.map((port) => [port.id, port]));
  const issues: EdgeEndpointIssue[] = [];
  for (const edge of edges) {
    for (const side of ["from", "to"] as const) {
      const endpoint = edge[side];
      const port = portsById.get(endpointPortId(endpoint));
      if (port === undefined) {
        issues.push({ edgeId: edge.id, endpoint: side, reason: `端口不存在: ${endpointPortId(endpoint)}` });
        continue;
      }
      if (port.direction !== endpoint.port.direction) {
        issues.push({ edgeId: edge.id, endpoint: side, reason: `端口方向不符: 期望 ${endpoint.port.direction} 实际 ${port.direction}` });
      }
      const expectedPipe = edge.kind === "pipe";
      if (port.isPipe !== expectedPipe) {
        issues.push({ edgeId: edge.id, endpoint: side, reason: `isPipe 冲突: 边 kind=${edge.kind} 端口 isPipe=${port.isPipe}` });
      }
    }
  }
  return issues;
}

/** sidecar 加载解析（边界校验；格式不符抛错，绝不静默吞）。 */
export function parseEdgeTable(json: unknown): ExplicitEdgeTable {
  if (typeof json !== "object" || json === null) {
    throw new Error("边表不是对象");
  }
  const table = json as Partial<ExplicitEdgeTable>;
  if (table.format !== EDGE_TABLE_FORMAT) {
    throw new Error(`边表 format 不符: 期望 ${EDGE_TABLE_FORMAT} 实际 ${String(table.format)}`);
  }
  if (typeof table.blueprintCode !== "string" || typeof table.sourceHash !== "string") {
    throw new Error("边表缺少 blueprintCode/sourceHash");
  }
  if (!Array.isArray(table.edges) || !Array.isArray(table.disabled)) {
    throw new Error("边表缺少 edges/disabled 数组");
  }
  for (const edge of table.edges) {
    if (
      typeof edge?.id !== "string" || (edge.kind !== "belt" && edge.kind !== "pipe")
      || typeof edge.from?.entityId !== "string" || typeof edge.to?.entityId !== "string"
      || typeof edge.from?.port?.group !== "string" || typeof edge.to?.port?.group !== "string"
      || typeof edge.from?.cell?.x !== "number" || typeof edge.to?.cell?.x !== "number"
    ) {
      throw new Error(`边格式非法: ${JSON.stringify(edge)?.slice(0, 120)}`);
    }
  }
  return table as ExplicitEdgeTable;
}
