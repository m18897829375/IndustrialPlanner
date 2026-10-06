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
import { buildFacingIndex, EDGE_TO_ANGLE } from "./official-facing";
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

/** 官方 Y 角 → 平台流向角：平台角 = (90 − y) % 360（单格段声明方向实证映射）。 */
function officialYToPlatformDir(y: number): QuarterRotation {
  return (((90 - Math.trunc(y)) % 360) + 360) % 360 as QuarterRotation;
}

/**
 * 单格段方向解析（F2 定案：忠实官方声明，不靠猜）。
 * 优先级：① 声明 (directionIn, directionOut) 完整 → 直接用（含声明转弯）；
 *         ② 仅 directionOut → straight；③ 无声明 → 邻接推断 → 兜底 E。
 * 声明方向的下游连通性不归此处裁决——由 auditDeclaredDirections 在全部放置与
 * 接驳完成后统一审计写入报告（断头不改写声明）。
 */
function resolveSingleCellDirs(
  ctx: ConverterContext,
  node: OfficialBlueprintNode,
  cell: GridPoint,
  kind: LogisticsKind,
): { dIn: QuarterRotation; dOut: QuarterRotation } {
  const dInRaw = node.transform?.directionIn?.y;
  const dOutRaw = node.transform?.directionOut?.y;
  if (dInRaw !== undefined && dInRaw !== null && dOutRaw !== undefined && dOutRaw !== null) {
    return { dIn: officialYToPlatformDir(dInRaw), dOut: officialYToPlatformDir(dOutRaw) };
  }
  if (dOutRaw !== undefined && dOutRaw !== null) {
    const d = officialYToPlatformDir(dOutRaw);
    return { dIn: d, dOut: d };
  }
  const inferred = inferSingleCellDir(ctx, cell, kind);
  const d = inferred ?? 0;
  return { dIn: d, dOut: d };
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
    const dirs = cells.map((cell, i) => {
      const next = cells[i + 1];
      if (next !== undefined) {
        return dirAngle(next.x - cell.x, next.y - cell.y) ?? 0;
      }
      const prev = cells[i - 1]!;
      return dirAngle(cell.x - prev.x, cell.y - prev.y) ?? 0;
    });
    for (let i = 0; i < cells.length; i++) {
      const dIn = i > 0 ? dirs[i - 1]! : dirs[i]!;
      const { shape, rotation } = classifyLogistics(dIn, dirs[i]!);
      addLogiCell(ctx, kind, cells[i]!.x, cells[i]!.y, shape, rotation);
    }
  }

  // 第二遍：单格段（忠实官方声明 directionIn/Out；无声明才邻接推断）
  for (const { node, kind, cells } of pendingSingle) {
    const { dIn, dOut } = resolveSingleCellDirs(ctx, node, cells[0]!, kind);
    const { shape, rotation } = classifyLogistics(dIn, dOut);
    addLogiCell(ctx, kind, cells[0]!.x, cells[0]!.y, shape, rotation);
  }
}

/** 平台流向角 → 格步进。 */
const DIR_DELTA: Readonly<Record<QuarterRotation, GridPoint>> = {
  0: { x: 1, y: 0 },
  90: { x: 0, y: 1 },
  180: { x: -1, y: 0 },
  270: { x: 0, y: -1 },
};

const DIR_NAME: Readonly<Record<QuarterRotation, string>> = {
  0: "E", 90: "S", 180: "W", 270: "N",
};

/**
 * 单格段声明方向下游连通审计（在全部物流放置 + 端口接驳完成后调用）。
 * 忠实采用声明后，声明出向无对接的格子写入报告（断头不改写声明）：
 * 下游对接 = 同族物流格占用，或该方向命中设备 input 端口朝向。
 * 仅供用户知悉"原蓝图可能为断头/装饰带，或平台无法表达的宽容结构"。
 */
export function auditDeclaredDirections(
  ctx: ConverterContext,
  nodes: readonly OfficialBlueprintNode[],
): string[] {
  const facing = buildFacingIndex(ctx);
  const divergences: string[] = [];
  for (const node of nodes) {
    const kind = LOGISTICS_TEMPLATE_KIND[node.templateId];
    if (kind === undefined) continue;
    const cells = logisticsNodeCells(ctx, node);
    if (cells.length !== 1) continue;
    const dOutRaw = node.transform?.directionOut?.y;
    if (dOutRaw === undefined || dOutRaw === null) continue;
    const dOut = officialYToPlatformDir(dOutRaw);
    const cell = cells[0]!;
    const delta = DIR_DELTA[dOut];
    const nx = cell.x + delta.x;
    const ny = cell.y + delta.y;

    // (a) 同族物流格占用（下游格）
    if (ctx.cellOwner.has(cellOwnerKey(kind, nx, ny))) continue;
    // (b) 设备 input 端口朝向本格（端口外侧格=本格，且从本格看设备的方向 = 声明出向）
    const candidates = facing.get(`${cell.x}:${cell.y}:${kind === "pipe"}`) ?? [];
    const hitsInput = candidates.some(
      (c) => c.direction === "input" && EDGE_TO_ANGLE[c.mEdge] === dOut,
    );
    if (hitsInput) continue;

    divergences.push(
      `⚠️ 单格段声明方向下游无对接: (${cell.x},${cell.y}) ${kind} 声明出向=${DIR_NAME[dOut]}(${dOut})`
      + `（原蓝图可能为断头/装饰带，或属平台无法表达的宽容结构）`,
    );
  }
  return divergences;
}
