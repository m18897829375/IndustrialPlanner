import type { GridEdge } from "@/domain/shared/grid";
import { resolveRotatedPortGeometry } from "@/shared/geometry/port";
import {
  cellOwnerKey,
  type ConverterContext,
  type LogisticsKind,
} from "./official-context";
import {
  classifyLogistics,
  logisticsNodeCells,
  LOGISTICS_TEMPLATE_KIND,
} from "./official-logistics";
import type { QuarterRotation } from "./official-types";

/**
 * 端口接驳（E 规则，最高风险模块；与 convert_v5.py adapt_line_endpoints 逐行同构）。
 *
 * 平台连通规则严格（端口格相邻 + 边互对 + isPipe 一致），物流线首/末格若与设备
 * 端口几何接触但带口朝向不符 → 自动改判 turn 使端口面对接（游戏侧宽容、平台侧
 * 严格的语义差补偿）。一格多设备端口冲突时写 warning，不静默。
 */

/** 边 → 平台流向角（与 official-anchor.dirAngle 同语义）。 */
const EDGE_TO_ANGLE: Readonly<Record<GridEdge, QuarterRotation>> = {
  EAST: 0,
  SOUTH: 90,
  WEST: 180,
  NORTH: 270,
};

const GRID_EDGE_ORDER: readonly GridEdge[] = ["NORTH", "EAST", "SOUTH", "WEST"];

/** 对边（从物流格看向设备的边）：顺时针 +2。 */
function oppositeEdge(edge: GridEdge): GridEdge {
  const index = GRID_EDGE_ORDER.indexOf(edge);
  return GRID_EDGE_ORDER[(index + 2) % 4]!;
}

interface DevicePortFacing {
  /** 从物流格看向设备的边（M）。 */
  readonly mEdge: GridEdge;
  readonly direction: "input" | "output";
  readonly entityId: string;
}

/**
 * 设备端口外侧格索引：(x, y, isPipe) → 朝向该格的设备端口列表。
 * 端口几何用物理帧（rot = 官方 rot），与平台 v6 语义一致。
 */
function buildFacingIndex(ctx: ConverterContext): Map<string, DevicePortFacing[]> {
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

function swapLogi(
  ctx: ConverterContext,
  eid: string,
  kind: LogisticsKind,
  x: number,
  y: number,
  dIn: QuarterRotation,
  dOut: QuarterRotation,
  dev: string,
): void {
  const { shape, rotation } = classifyLogistics(dIn, dOut);
  const newId = `${kind}_${shape}_1x1`;
  const entity = ctx.entities[eid]!;
  if (entity.definitionId !== newId || entity.rotation !== rotation) {
    ctx.entities[eid] = { ...entity, definitionId: newId, rotation };
    ctx.notes.push(`端口接驳: (${x},${y}) ${kind} → ${newId} rot=${rotation}（对接 ${dev}）`);
  }
}

export function adaptLineEndpoints(
  ctx: ConverterContext,
  nodes: readonly import("./official-types").OfficialBlueprintNode[],
): void {
  const facing = buildFacingIndex(ctx);
  const adapted = new Map<string, string>(); // cellOwnerKey → dev，防二次改写覆盖

  // 逐物流节点（需要线序，重新展开）
  for (const node of nodes) {
    const kind = LOGISTICS_TEMPLATE_KIND[node.templateId];
    if (kind === undefined) continue;
    const cells = logisticsNodeCells(ctx, node);
    if (cells.length === 0) continue;
    const endpoints: Array<{ index: number; isStart: boolean }> = cells.length === 1
      ? [{ index: 0, isStart: true }]
      : [{ index: 0, isStart: true }, { index: cells.length - 1, isStart: false }];

    for (const { index, isStart } of endpoints) {
      const cell = cells[index]!;
      const key = cellOwnerKey(kind, cell.x, cell.y);
      const eid = ctx.cellOwner.get(key);
      if (eid === undefined) continue;
      const entity = ctx.entities[eid]!;
      const d = entity.rotation as QuarterRotation; // 当前 out 流向（straight）或近似

      const candidates = facing.get(`${cell.x}:${cell.y}:${kind === "pipe"}`);
      if (candidates === undefined) continue;
      for (const { mEdge, direction, entityId: dev } of candidates) {
        const mAng = EDGE_TO_ANGLE[mEdge];
        if (direction === "output" && isStart) {
          // 设备输出 → 线首：带 input 边须朝设备（M）
          if ((mAng + 180) % 360 === d) continue; // 直带流出已通
          const delta = ((d - ((mAng + 180) % 360)) % 360 + 360) % 360;
          if (delta === 90 || delta === 270) {
            if (adapted.has(key)) {
              ctx.warnings.push(
                `⚠️ 端口接驳冲突: (${cell.x},${cell.y}) 已对接 ${adapted.get(key)}，`
                + `跳过 ${dev}（一格多设备端口，1×1 无法同时服务）`,
              );
              continue;
            }
            swapLogi(ctx, eid, kind, cell.x, cell.y, ((mAng + 180) % 360) as QuarterRotation, d, dev);
            adapted.set(key, dev);
          }
        } else if (direction === "input" && !isStart) {
          // 线末 → 设备输入：带 output 边须朝设备（M）
          if (d === mAng) continue; // 直带直入已通
          const delta = ((mAng - d) % 360 + 360) % 360;
          if (delta === 90 || delta === 270) {
            if (adapted.has(key)) {
              ctx.warnings.push(
                `⚠️ 端口接驳冲突: (${cell.x},${cell.y}) 已对接 ${adapted.get(key)}，`
                + `跳过 ${dev}（一格多设备端口，1×1 无法同时服务）`,
              );
              continue;
            }
            swapLogi(ctx, eid, kind, cell.x, cell.y, d, mAng, dev);
            adapted.set(key, dev);
          }
        }
      }
    }
  }
}
