import type { ExplicitEdge } from "@/domain/document/explicit-edges";
import type {
  CompiledSimulationDevice,
  CompiledSimulationPhysicalConnection,
  CompiledSimulationPort,
  SimulationCompileDiagnostic,
} from "../contracts";

/**
 * 显式边表 → 编译期物理连接调和。
 *
 * 语义（边表在场即整体权威）：
 * - 几何推断依旧先跑（作为诊断依据与顺序基准），随后按边表过滤：
 *   边表没有的边 = 不连（缺边/禁边从几何结果中剔除，info 诊断留痕）；
 * - 边表有而几何推断不出的边（典型为 manual 人工边）：满足平台约束
 *   （端口存在、方向/管道类型一致、几何相邻、非"双非物流设备直连"）
 *   时追加，违反任一约束 → error 诊断并跳过，绝不静默造边；
 * - 端点不可解析比例 > 50%（典型为编辑器改动后实体 ID 漂移）→ 判边表过期，
 *   整体回退几何推断 + error 诊断，不做部分采纳。
 *
 * 零漂移保证：边表 == 纯推断结果时，输出与纯几何编译逐条相等
 * （几何顺序保持，无追加项）。
 */

/** 边表端点 → 编译期端口 ID（`device:${entityId}/port:${group}.${id}.${direction}`）。 */
function compiledPortId(edge: ExplicitEdge["from"]): string {
  return `device:${edge.entityId}/port:${edge.port.group}.${edge.port.id}.${edge.port.direction}`;
}

function connectionKey(sourcePortId: string, targetPortId: string): string {
  return `${sourcePortId}->${targetPortId}`;
}

/** 不可解析比例超过该阈值时判定边表整体过期（ID 漂移），回退几何推断。 */
const STALE_THRESHOLD = 0.5;

export function reconcileExplicitConnections(
  explicitEdges: readonly ExplicitEdge[],
  geometricConnections: readonly CompiledSimulationPhysicalConnection[],
  ports: Readonly<Record<string, CompiledSimulationPort>>,
  devices: Readonly<Record<string, CompiledSimulationDevice>>,
  isGeneralLogisticsDevice: (definitionId: string) => boolean,
  diagnostics: SimulationCompileDiagnostic[],
): CompiledSimulationPhysicalConnection[] {
  // [1] 端点解析：边表端口引用 → 编译期端口
  const resolved = new Map<string, { edge: ExplicitEdge; sourcePortId: string; targetPortId: string }>();
  let unresolvedCount = 0;
  for (const edge of explicitEdges) {
    const sourcePortId = compiledPortId(edge.from);
    const targetPortId = compiledPortId(edge.to);
    const sourcePort = ports[sourcePortId];
    const targetPort = ports[targetPortId];
    if (sourcePort === undefined || targetPort === undefined) {
      unresolvedCount++;
      continue;
    }
    resolved.set(connectionKey(sourcePortId, targetPortId), { edge, sourcePortId, targetPortId });
  }

  // [2] 过期判定：大面积失配 = 编辑器改动后 ID 漂移，整体回退
  if (
    explicitEdges.length > 0
    && unresolvedCount / explicitEdges.length > STALE_THRESHOLD
  ) {
    diagnostics.push({
      severity: "error",
      code: "stale-explicit-edge-table",
      message:
        `显式边表与文档实体失配（${unresolvedCount}/${explicitEdges.length} 条边端口不可解析），`
        + `已整体回退几何推断。请重新导出边表（--edges）。`,
    });
    return [...geometricConnections];
  }
  // 非过期级别的个别不可解析：逐条 error，不静默丢弃
  for (const edge of explicitEdges) {
    const key = connectionKey(compiledPortId(edge.from), compiledPortId(edge.to));
    if (!resolved.has(key)) {
      diagnostics.push({
        severity: "error",
        code: "unresolved-explicit-edge",
        message: `显式边 ${edge.id} 端口不可解析: ${compiledPortId(edge.from)} -> ${compiledPortId(edge.to)}`,
      });
    }
  }

  // [3] 几何结果按边表过滤（缺边=不连；保持几何顺序，零漂移）
  const result: CompiledSimulationPhysicalConnection[] = [];
  const geometricKeys = new Set<string>();
  for (const connection of geometricConnections) {
    const key = connectionKey(connection.sourcePortId, connection.targetPortId);
    geometricKeys.add(key);
    if (resolved.has(key)) {
      result.push(connection);
    } else {
      diagnostics.push({
        severity: "info",
        code: "explicit-edge-omitted",
        message: `几何推断边被显式边表省略: ${connection.id}`,
      });
    }
  }

  // [4] 边表有而几何不出的边（manual）：平台约束校验后追加
  for (const { edge, sourcePortId, targetPortId } of resolved.values()) {
    const key = connectionKey(sourcePortId, targetPortId);
    if (geometricKeys.has(key)) continue;
    const sourcePort = ports[sourcePortId]!;
    const targetPort = ports[targetPortId]!;

    const expectedPipe = edge.kind === "pipe";
    if (sourcePort.isPipe !== expectedPipe || targetPort.isPipe !== expectedPipe) {
      diagnostics.push({
        severity: "error",
        code: "unsupported-explicit-edge",
        message: `显式边 ${edge.id} 管道类型不符（kind=${edge.kind}，端口 isPipe=${sourcePort.isPipe}/${targetPort.isPipe}）`,
      });
      continue;
    }
    // 平台规则：双非物流设备不直连
    const sourceDevice = devices[sourcePort.deviceId];
    const targetDevice = devices[targetPort.deviceId];
    if (
      sourceDevice !== undefined
      && targetDevice !== undefined
      && !isGeneralLogisticsDevice(sourceDevice.definitionId)
      && !isGeneralLogisticsDevice(targetDevice.definitionId)
    ) {
      diagnostics.push({
        severity: "error",
        code: "unsupported-explicit-edge",
        message: `显式边 ${edge.id} 违反平台规则：双非物流设备不直连（${sourcePort.deviceId} -> ${targetPort.deviceId}）`,
      });
      continue;
    }
    // 仿真健全性：物理连接要求端口几何相邻（互为内外侧）
    const adjacent = sourcePort.outsideGridPoint.x === targetPort.insideGridPoint.x
      && sourcePort.outsideGridPoint.y === targetPort.insideGridPoint.y
      && sourcePort.insideGridPoint.x === targetPort.outsideGridPoint.x
      && sourcePort.insideGridPoint.y === targetPort.outsideGridPoint.y;
    if (!adjacent) {
      diagnostics.push({
        severity: "error",
        code: "unsupported-explicit-edge",
        message: `显式边 ${edge.id} 端口几何不相邻（${sourcePortId} -> ${targetPortId}），仿真不支持隔空连接`,
      });
      continue;
    }

    result.push({
      id: `connection:${sourcePortId}->${targetPortId}`,
      sourcePortId,
      targetPortId,
      sourceInsideGridPoint: sourcePort.insideGridPoint,
      targetInsideGridPoint: targetPort.insideGridPoint,
    });
  }

  return result;
}
