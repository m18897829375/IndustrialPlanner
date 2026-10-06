import type {
  CompiledSimulationDevice,
  CompiledSimulationPort,
} from "@/simulation/contracts/types";
import { compilePhysicalConnections } from "@/simulation/topology/compiler";
import { resolveRotatedPortGeometry } from "@/shared/geometry/port";
import type { ConverterContext } from "./official-context";
import { buildImportEdges, type EdgeSourcePort } from "./official-edge-table";
import type { ConvertReport } from "./official-types";

/**
 * 拓扑自检：直接调平台本尊 compilePhysicalConnections（不重写连通规则）。
 *
 * 端口几何与 Python validate() 同构：设备用物理帧（rot = 官方 rot），
 * 物流节用 emitted rotation。compilePhysicalConnections 只读取 port 的
 * id/deviceId/direction/isPipe/insideGridPoint/outsideGridPoint 与 device 的
 * definitionId，故此处构造结构化子集并以类型断言收窄（上游新增字段不影响运行）。
 *
 * 返回值同时携带完整显式边（ExplicitEdge[]，见 official-edge-table.ts）——
 * 边表 sidecar 的生成点就在此，与运行时编译同源同码。
 */

export type MinimalPort = EdgeSourcePort;

export function buildMinimalPorts(ctx: ConverterContext): MinimalPort[] {
  const ports: MinimalPort[] = [];
  for (const eid of ctx.order) {
    const entity = ctx.entities[eid]!;
    const definition = ctx.registry.queries.findEntityDefinition(entity.definitionId);
    if (definition === null) continue;
    // 设备：物理帧 = 官方 rot；物流节：emitted rotation（identity 类两者相等）
    const rotation = (ctx.devMeta.get(eid)?.rotOfficial ?? entity.rotation) as 0 | 90 | 180 | 270;
    for (const group of definition.portGroups) {
      const directions: Array<"input" | "output"> = group.direction === "bidirectional"
        ? ["input", "output"]
        : [group.direction];
      for (const port of group.ports) {
        const geometry = resolveRotatedPortGeometry({
          footprint: definition.footprint,
          port,
          rotation,
        });
        const inside = {
          x: entity.position.x + geometry.cell.x,
          y: entity.position.y + geometry.cell.y,
        };
        const outside = { x: inside.x + geometry.delta.x, y: inside.y + geometry.delta.y };
        for (const direction of directions) {
          ports.push({
            id: `${eid}/${group.id}/${port.id}:${direction}`,
            deviceId: eid,
            direction,
            isPipe: group.isPipe,
            insideGridPoint: inside,
            outsideGridPoint: outside,
          });
        }
      }
    }
  }
  return ports;
}

export function checkImportTopology(
  ctx: ConverterContext,
): ConvertReport["topologyCheck"] {
  const ports = buildMinimalPorts(ctx);
  const devices: Record<string, { definitionId: string }> = {};
  for (const eid of ctx.order) {
    devices[eid] = { definitionId: ctx.entities[eid]!.definitionId };
  }

  const connections = compilePhysicalConnections(
    ports as unknown as CompiledSimulationPort[],
    devices as unknown as Record<string, CompiledSimulationDevice>,
    (definitionId) => ctx.registry.queries.isGeneralLogisticsDevice(definitionId),
  );

  // "几何接触但未连通"警告（与 Python validate() problems 同构）：
  // 设备端口外侧格被同族物流占用，但该 (设备, 物流) 对不在连接集合中。
  const connectedPairs = new Set<string>();
  for (const connection of connections) {
    const [sourceDevice, targetDevice] = [connection.sourcePortId, connection.targetPortId]
      .map((portId) => portId.slice(0, portId.indexOf("/")));
    connectedPairs.add(`${sourceDevice}->${targetDevice}`);
    connectedPairs.add(`${targetDevice}->${sourceDevice}`);
  }

  const unconnectedPortWarnings: string[] = [];
  for (const eid of ctx.order) {
    const meta = ctx.devMeta.get(eid);
    if (meta === undefined) continue; // 只看设备
    const definition = ctx.registry.queries.findEntityDefinition(meta.definitionId);
    if (definition === null) continue;
    for (const group of definition.portGroups) {
      for (const port of group.ports) {
        const geometry = resolveRotatedPortGeometry({
          footprint: definition.footprint,
          port,
          rotation: meta.rotOfficial,
        });
        const inside = {
          x: meta.x + geometry.cell.x,
          y: meta.y + geometry.cell.y,
        };
        const outside = { x: inside.x + geometry.delta.x, y: inside.y + geometry.delta.y };
        const kind = group.isPipe ? "pipe" : "belt";
        const occupier = ctx.cellOwner.get(`${kind}:${outside.x}:${outside.y}`);
        if (occupier === undefined) continue;
        if (!connectedPairs.has(`${eid}->${occupier}`)) {
          unconnectedPortWarnings.push(
            `⚠️ ${meta.definitionId}(${eid}) 端口${group.direction}@(${inside.x},${inside.y})${geometry.edge} `
            + `与物流格(${outside.x},${outside.y})几何接触但未连通`,
          );
        }
      }
    }
  }

  const edges = buildImportEdges(connections, ports);

  return {
    connectionCount: connections.length,
    unconnectedPortWarnings,
    connectionPairs: connections.map((connection) => connection.id.replace(/^connection:/, "")),
    connections: edges,
    ports,
  };
}
