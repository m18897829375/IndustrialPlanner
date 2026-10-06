import type { GridEdge } from "@/domain/shared/grid";
import { resolveRotatedPortGeometry } from "@/shared/geometry/port";
import type { ConverterContext } from "./official-context";
import type { QuarterRotation } from "./official-types";

/**
 * 设备端口朝向索引（从 port-adaptation 抽取共用）：(x, y, isPipe) → 朝向该格外侧的设备端口列表。
 * 端口几何用物理帧（rot = 官方 rot），与平台 v6 语义一致。
 * 供端口接驳（E 规则）与单格段声明方向连通审计共用。
 */

/** 边 → 平台流向角（与 official-anchor.dirAngle 同语义）。 */
export const EDGE_TO_ANGLE: Readonly<Record<GridEdge, QuarterRotation>> = {
  EAST: 0,
  SOUTH: 90,
  WEST: 180,
  NORTH: 270,
};

const GRID_EDGE_ORDER: readonly GridEdge[] = ["NORTH", "EAST", "SOUTH", "WEST"];

/** 对边（从物流格看向设备的边）：顺时针 +2。 */
export function oppositeEdge(edge: GridEdge): GridEdge {
  const index = GRID_EDGE_ORDER.indexOf(edge);
  return GRID_EDGE_ORDER[(index + 2) % 4]!;
}

export interface DevicePortFacing {
  /** 从物流格看向设备的边（M）。 */
  readonly mEdge: GridEdge;
  readonly direction: "input" | "output";
  readonly entityId: string;
}

/** 设备端口外侧格索引：(x, y, isPipe) → 朝向该格的设备端口列表。 */
export function buildFacingIndex(ctx: ConverterContext): Map<string, DevicePortFacing[]> {
  const facing = new Map<string, DevicePortFacing[]>();
  for (const eid of ctx.order) {
    const meta = ctx.devMeta.get(eid);
    if (meta === undefined) continue; // 跳过物流节
    const definition = ctx.registry.queries.findEntityDefinition(meta.definitionId);
    if (definition === null) continue;
    for (const group of definition.portGroups) {
      const directions: Array<"input" | "output"> = group.direction === "bidirectional"
        ? ["input", "output"]
        : [group.direction];
      for (const port of group.ports) {
        const geometry = resolveRotatedPortGeometry({
          footprint: definition.footprint,
          port,
          rotation: meta.rotOfficial,
        });
        const insideX = meta.x + geometry.cell.x;
        const insideY = meta.y + geometry.cell.y;
        const outsideX = insideX + geometry.delta.x;
        const outsideY = insideY + geometry.delta.y;
        const key = `${outsideX}:${outsideY}:${group.isPipe}`;
        let list = facing.get(key);
        if (list === undefined) {
          list = [];
          facing.set(key, list);
        }
        const mEdge = oppositeEdge(geometry.edge);
        for (const direction of directions) {
          list.push({ mEdge, direction, entityId: eid });
        }
      }
    }
  }
  return facing;
}
