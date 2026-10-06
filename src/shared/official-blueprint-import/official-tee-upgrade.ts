import type { GridEdge } from "@/domain/shared/grid";
import { resolveRotatedPortGeometry } from "@/shared/geometry/port";
import {
  cellOwnerKey,
  type ConverterContext,
  type LogisticsKind,
} from "./official-context";
import type { QuarterRotation } from "./official-types";

/**
 * T 型汇入升级（游戏侧自动适配 vs 平台端口严格互对的表达力补偿）。
 *
 * 游戏内设备 output 端口可以从带/管侧面注入（T 型接入自动适配）；
 * 平台 1×1 straight/turn 仅两个端口，无法表达"主流经过 + 侧向注入"。
 * 本阶段检测"设备 output 外侧格是同 kind 带/管节但端口边不互对"的位置，
 * 把该格升级为 converger（3 进 1 出）：旋转保证主流进出方向不变、注入方向接入。
 *
 * 对已确认为"废口平行贴带"的注入同样安全（汇流器空着该进口，主流照走）。
 */

const EDGE_TO_ANGLE: Readonly<Record<GridEdge, QuarterRotation>> = {
  EAST: 0,
  SOUTH: 90,
  WEST: 180,
  NORTH: 270,
};

const GRID_EDGE_ORDER: readonly GridEdge[] = ["NORTH", "EAST", "SOUTH", "WEST"];

function oppositeEdge(edge: GridEdge): GridEdge {
  return GRID_EDGE_ORDER[(GRID_EDGE_ORDER.indexOf(edge) + 2) % 4]!;
}

/** 物流节的（进方向, 出方向）角（由 shape+rot 经注册表端口几何计算）。 */
function flowDirectionsOf(
  ctx: ConverterContext,
  entityId: string,
): { inFlow: QuarterRotation; outFlow: QuarterRotation } | null {
  const entity = ctx.entities[entityId]!;
  const definition = ctx.registry.queries.findEntityDefinition(entity.definitionId);
  if (definition === null) return null;
  let inFlow: QuarterRotation | null = null;
  let outFlow: QuarterRotation | null = null;
  for (const group of definition.portGroups) {
    for (const port of group.ports) {
      const geo = resolveRotatedPortGeometry({
        footprint: definition.footprint,
        port,
        rotation: entity.rotation as QuarterRotation,
      });
      const ang = EDGE_TO_ANGLE[geo.edge];
      // 端口边的"物品行进方向"：进端口=从 outside 进格（边方向的反方向）；出端口=出格（边方向）
      const travel = group.direction === "input" ? ((ang + 180) % 360) as QuarterRotation : ang;
      if (group.direction === "input") {
        if (inFlow === null) inFlow = travel;
      } else if (group.direction === "output") {
        if (outFlow === null) outFlow = travel;
      }
    }
  }
  if (inFlow === null || outFlow === null) return null;
  return { inFlow, outFlow };
}

/** 设备 output 端口与物流节格按当前 shape 是否已连通（端口边互对 + 格互对）。 */
function isConnectable(
  ctx: ConverterContext,
  deviceEntityId: string,
  devInside: { x: number; y: number },
  logiEntityId: string,
): boolean {
  const logiEntity = ctx.entities[logiEntityId]!;
  const logiDef = ctx.registry.queries.findEntityDefinition(logiEntity.definitionId);
  if (logiDef === null) return false;
  for (const group of logiDef.portGroups) {
    if (group.direction !== "input" && group.direction !== "bidirectional") continue;
    for (const port of group.ports) {
      const geo = resolveRotatedPortGeometry({
        footprint: logiDef.footprint,
        port,
        rotation: logiEntity.rotation as QuarterRotation,
      });
      const logiInside = {
        x: logiEntity.position.x + geo.cell.x,
        y: logiEntity.position.y + geo.cell.y,
      };
      const logiOutside = { x: logiInside.x + geo.delta.x, y: logiInside.y + geo.delta.y };
      if (logiOutside.x === devInside.x && logiOutside.y === devInside.y) {
        return true;
      }
    }
  }
  return false;
}

export function upgradeTeeJunctions(ctx: ConverterContext): void {
  const upgraded = new Set<string>(); // 已升级的物流节（一格只升一次）

  for (const eid of ctx.order) {
    if (ctx.logiMeta.has(eid)) continue; // 只看设备
    const meta = ctx.devMeta.get(eid);
    if (meta === undefined) continue;
    const definition = ctx.registry.queries.findEntityDefinition(meta.definitionId);
    if (definition === null) continue;

    for (const group of definition.portGroups) {
      if (group.direction !== "output" && group.direction !== "bidirectional") continue;
      const kind: LogisticsKind = group.isPipe ? "pipe" : "belt";
      for (const port of group.ports) {
        const geo = resolveRotatedPortGeometry({
          footprint: definition.footprint,
          port,
          rotation: meta.rotOfficial,
        });
        const devInside = { x: meta.x + geo.cell.x, y: meta.y + geo.cell.y };
        const outside = { x: devInside.x + geo.delta.x, y: devInside.y + geo.delta.y };
        const key = cellOwnerKey(kind, outside.x, outside.y);
        const logiId = ctx.cellOwner.get(key);
        if (logiId === undefined) continue;
        const logiEntity = ctx.entities[logiId]!;
        // 只处理 straight/turn（已升级过的 converger 天然可再接入，无需处理）
        if (!logiEntity.definitionId.includes("_1x1")) continue;
        if (isConnectable(ctx, eid, devInside, logiId)) continue;

        const flow = flowDirectionsOf(ctx, logiId);
        if (flow === null) continue;
        // 注入方向 = 物品离开设备端口进入格子的行进方向（= 端口边方向角）
        const inject = EDGE_TO_ANGLE[geo.edge];
        if (inject === flow.outFlow) continue; // 注入方向=主流出方向（设备在主流上游侧顺流注入），非 T 型场景

        // converger rot：出方向 = 主流出方向。converger rot=0 出 S(90) → rot=(outFlow-90)%360
        const convRot = (((flow.outFlow - 90) % 360) + 360) % 360 as QuarterRotation;
        // belt 汇流器 ID 是 log_converger；pipe 是 pipe_converger
        const convergerId = kind === "belt" ? "log_converger" : "pipe_converger";
        if (ctx.registry.queries.findEntityDefinition(convergerId) === null) continue;

        if (upgraded.has(logiId)) continue;
        ctx.entities[logiId] = {
          ...logiEntity,
          definitionId: convergerId,
          rotation: convRot,
        };
        upgraded.add(logiId);
        ctx.notes.push(
          `T 型汇入升级: (${outside.x},${outside.y}) ${kind} ${logiEntity.definitionId} rot=${logiEntity.rotation}`
          + ` → ${convergerId} rot=${convRot}（主流 ${flow.inFlow}→${flow.outFlow}，接入 ${eid} 从 ${inject} 注入）`,
        );
      }
    }
  }
}
