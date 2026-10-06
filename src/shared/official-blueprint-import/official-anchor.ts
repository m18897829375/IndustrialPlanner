import type { GridPoint, GridRectSize } from "@/domain/shared/grid";
import type {
  OfficialBlueprintNode,
  QuarterRotation,
} from "./official-types";

/**
 * 官方坐标 ↔ 平台坐标变换（实证依据见 workspace/blueprint-sim/RESEARCH.md）：
 *   A. 官方锚点随旋转变化：rot=0→(minX,minZ) 90→(minX,maxZ) 180→(maxX,maxZ) 270→(maxX,minZ)
 *   B. 坐标镜像：platform.y = (zSize-1) - official.z（cell 级）
 *   C. 平台 position = 旋转后 footprint 的左上角；rot∈{90,270} 占地宽高互换
 */

/** 官方节点朝向角：rotation.y 可能缺失，回退 direction.y。 */
export function nodeOfficialRot(node: OfficialBlueprintNode): QuarterRotation {
  const tr = node.transform;
  const value = tr?.rotation?.y ?? tr?.direction?.y ?? 0;
  return ((Math.trunc(value) % 360) + 360) % 360 as QuarterRotation;
}

/**
 * 设备锚点格：优先 transform.position（官方语义 = 随旋转的角落格）。
 * 极少数节点仅有 interactiveParam（占地中心），回退按 rot=0 角点近似。
 */
export function nodeAnchor(node: OfficialBlueprintNode): { ax: number; az: number } {
  const tr = node.transform;
  const pos = tr?.position;
  if (pos !== undefined) {
    return { ax: Math.trunc(pos.x), az: Math.trunc(pos.z) };
  }
  const ip = tr?.interactiveParam?.position;
  return {
    ax: Math.round((ip?.x ?? 0.5) - 0.5),
    az: Math.round((ip?.z ?? 0.5) - 0.5),
  };
}

export interface OfficialFootprint {
  /** 官方占地左上角 x（官方坐标系，未镜像）。 */
  readonly x0: number;
  /** 官方占地左上角 z（官方坐标系，未镜像）。 */
  readonly z0: number;
  /** 旋转后占地宽（rot∈{90,270} 时为注册表 height）。 */
  readonly w: number;
  /** 旋转后占地高（rot∈{90,270} 时为注册表 width）。 */
  readonly h: number;
}

/**
 * 官方锚点还原表（实证）：由锚点 + 朝向 + 注册表基准尺寸还原官方占地左上角。
 * W/H 为注册表 rotation=0 基准尺寸；官方 rot∈{90,270} 时占地宽高互换。
 */
export function officialFootprintOrigin(
  ax: number,
  az: number,
  rot: QuarterRotation,
  baseWidth: number,
  baseHeight: number,
): OfficialFootprint {
  const w = rot === 0 || rot === 180 ? baseWidth : baseHeight;
  const h = rot === 0 || rot === 180 ? baseHeight : baseWidth;
  switch (rot) {
    case 0:
      return { x0: ax, z0: az, w, h };
    case 90:
      return { x0: ax, z0: az - h + 1, w, h };
    case 180:
      return { x0: ax - w + 1, z0: az - h + 1, w, h };
    case 270:
      return { x0: ax - w + 1, z0: az, w, h };
  }
}

/**
 * 官方占地左上角 → 平台 position（旋转后 footprint 左上角，含 Z 镜像）。
 * zMax = zSize - 1；镜像 y = zMax - z0 - (h-1)，x 不变。
 */
export function toPlatformPosition(
  footprint: OfficialFootprint,
  zMax: number,
): GridPoint {
  return { x: footprint.x0, y: zMax - footprint.z0 - (footprint.h - 1) };
}

/** 官方单点 → 平台坐标（cell 级镜像）。 */
export function toPlatformPoint(x: number, z: number, zMax: number): GridPoint {
  return { x: Math.trunc(x), y: zMax - Math.trunc(z) };
}

/**
 * 物流折线逐格展开（平台坐标，调用方先做 Z 镜像）。
 * points 顺序 = 流向（实证）；逐段线性插值，相邻去重。
 */
export function expandPolyline(pts: readonly GridPoint[]): GridPoint[] {
  const cells: GridPoint[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    if (steps === 0) {
      const last = cells[cells.length - 1];
      if (last === undefined || last.x !== a.x || last.y !== a.y) {
        cells.push({ x: a.x, y: a.y });
      }
      continue;
    }
    for (let s = 0; s <= steps; s++) {
      const cell = {
        x: Math.round(a.x + ((b.x - a.x) * s) / steps),
        y: Math.round(a.y + ((b.y - a.y) * s) / steps),
      };
      const last = cells[cells.length - 1];
      if (last === undefined || last.x !== cell.x || last.y !== cell.y) {
        cells.push(cell);
      }
    }
  }
  return cells;
}

/** 平台流向角：0=E 90=S 180=W 270=N（屏幕坐标，与 rotation 同语义）。 */
export function dirAngle(dx: number, dy: number): QuarterRotation | null {
  if (dx > 0) return 0;
  if (dy > 0) return 90;
  if (dx < 0) return 180;
  if (dy < 0) return 270;
  return null;
}

/** 旋转后占地尺寸（rot∈{90,270} 宽高互换）。 */
export function rotatedSize(size: GridRectSize, rot: QuarterRotation): GridRectSize {
  return rot === 90 || rot === 270
    ? { width: size.height, height: size.width }
    : size;
}
