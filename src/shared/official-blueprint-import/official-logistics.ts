import type { GridPoint } from "@/domain/shared/grid";
import {
  dirAngle,
  expandPolyline,
  toPlatformPoint,
} from "./official-anchor";
import {
  cellOwnerKey,
  type ConverterContext,
  type LogisticsKind,
} from "./official-context";
import type {
  OfficialBlueprintNode,
  QuarterRotation,
} from "./official-types";

/**
 * 物流展开（移植自 convert_v5.py convert_logistics，两遍法）：
 *   1. 先展开全部多格段（几何方向充分确定流向）
 *   2. 再处理单格段（邻接推断依赖邻格已存在）
 * points 顺序 = 流向（实证）；directionIn/Out 与几何流向脱钩不可信，
 * 唯一例外是单格段 fallback：平台角 = (90 - directionOut.y) % 360。
 */

export const LOGISTICS_TEMPLATE_KIND: Readonly<Record<string, LogisticsKind>> = {
  grid_belt_01: "belt",
  log_pipe_01: "pipe",
};

export type LogisticsShape = "straight" | "turn_cw" | "turn_ccw";

/** turn 终版查表（实证）：(d_in, d_out) → (shape, rotation)。d: 0=E 90=S 180=W 270=N。 */
export function classifyLogistics(
  dIn: QuarterRotation,
  dOut: QuarterRotation,
): { shape: LogisticsShape; rotation: QuarterRotation } {
  if (dIn === dOut) {
    return { shape: "straight", rotation: dOut };
  }
  if (((dOut - dIn) % 360 + 360) % 360 === 90) {
    return { shape: "turn_cw", rotation: ((dIn + 180) % 360) as QuarterRotation };
  }
  return { shape: "turn_ccw", rotation: ((dIn + 270) % 360) as QuarterRotation };
}

const EDGE_ANGLES: readonly { edge: string; ang: QuarterRotation; dx: number; dy: number }[] = [
  { edge: "E", ang: 0, dx: 1, dy: 0 },
  { edge: "S", ang: 90, dx: 0, dy: 1 },
  { edge: "W", ang: 180, dx: -1, dy: 0 },
  { edge: "N", ang: 270, dx: 0, dy: -1 },
];

/** 单格段流向推断：上游=邻格流向指向本格；下游=本格流向指向邻格。 */
function inferSingleCellDir(
  ctx: ConverterContext,
  cell: GridPoint,
  kind: LogisticsKind,
): QuarterRotation | null {
  const ups: QuarterRotation[] = [];
  const downs: QuarterRotation[] = [];
  for (const { ang, dx, dy } of EDGE_ANGLES) {
    const neighborId = ctx.cellOwner.get(cellOwnerKey(kind, cell.x + dx, cell.y + dy));
    if (neighborId === undefined) continue;
    const neighborRot = ctx.entities[neighborId]?.rotation;
    if (neighborRot === ((ang + 180) % 360)) {
      ups.push(ang); // 邻格流向指向本格
    } else if (neighborRot === ang) {
      downs.push(ang); // 本格流向指向邻格
    }
  }
  if (ups.length === 1 && downs.length === 0) {
    return ((ups[0]! + 180) % 360) as QuarterRotation; // 上游来向 = 穿过本格继续
  }
  if (downs.length === 1 && ups.length === 0) {
    return downs[0]!;
  }
  return null;
}

function addLogiCell(
  ctx: ConverterContext,
  kind: LogisticsKind,
  x: number,
  y: number,
  shape: LogisticsShape,
  rotation: QuarterRotation,
): void {
  const key = cellOwnerKey(kind, x, y);
  if (ctx.cellOwner.has(key)) {
    return; // 同族同格去重（带×管可叠放，不同 key）
  }
  const eid = `logistics-draft:${kind}:${x}:${y}`;
  const definitionId = `${kind}_${shape}_1x1`;
  ctx.entities[eid] = {
    id: eid,
    definitionId,
    position: { x, y },
    rotation,
    config: {},
    tags: [],
  };
  ctx.order.push(eid);
  ctx.cellOwner.set(key, eid);
  ctx.logiMeta.set(eid, { kind, x, y });
}

/** 每格流向（平台角）。多格段按几何；单格段邻接图推断，fallback directionOut。 */
function flowDirs(
  ctx: ConverterContext,
  node: OfficialBlueprintNode,
  cells: readonly GridPoint[],
  kind: LogisticsKind,
  fallbackDir: QuarterRotation | null,
): QuarterRotation[] {
  if (cells.length > 1) {
    return cells.map((cell, i) => {
      const next = cells[i + 1];
      if (next !== undefined) {
        return dirAngle(next.x - cell.x, next.y - cell.y) ?? 0;
      }
      const prev = cells[i - 1]!;
      return dirAngle(cell.x - prev.x, cell.y - prev.y) ?? 0;
    });
  }
  const inferred = inferSingleCellDir(ctx, cells[0]!, kind);
  return [inferred ?? fallbackDir ?? 0];
}

export function logisticsNodeCells(
  ctx: ConverterContext,
  node: OfficialBlueprintNode,
): GridPoint[] {
  const rawPts = node.transform?.points ?? [];
  const pts = rawPts.map((p) => toPlatformPoint(p.x, p.z, ctx.zMax));
  return expandPolyline(pts);
}

export function convertLogistics(
  ctx: ConverterContext,
  nodes: readonly OfficialBlueprintNode[],
): void {
  const pendingSingle: Array<{ node: OfficialBlueprintNode; kind: LogisticsKind; cells: GridPoint[] }> = [];

  // 第一遍：多格段（几何方向充分）
  for (const node of nodes) {
    const kind = LOGISTICS_TEMPLATE_KIND[node.templateId];
    if (kind === undefined) continue;
    const cells = logisticsNodeCells(ctx, node);
    if (cells.length === 0) continue;
    if (cells.length === 1) {
      pendingSingle.push({ node, kind, cells });
      continue;
    }
    const dirs = flowDirs(ctx, node, cells, kind, null);
    for (let i = 0; i < cells.length; i++) {
      const dIn = i > 0 ? dirs[i - 1]! : dirs[i]!;
      const { shape, rotation } = classifyLogistics(dIn, dirs[i]!);
      addLogiCell(ctx, kind, cells[i]!.x, cells[i]!.y, shape, rotation);
    }
  }

  // 第二遍：单格段（邻接推断 + directionOut fallback）
  for (const { node, kind, cells } of pendingSingle) {
    const dOutRaw = node.transform?.directionOut?.y;
    const fallbackDir = dOutRaw !== undefined && dOutRaw !== null
      ? (((90 - Math.trunc(dOutRaw)) % 360) + 360) % 360 as QuarterRotation
      : null;
    const dirs = flowDirs(ctx, node, cells, kind, fallbackDir);
    const { shape, rotation } = classifyLogistics(dirs[0]!, dirs[0]!);
    addLogiCell(ctx, kind, cells[0]!.x, cells[0]!.y, shape, rotation);
  }
}
