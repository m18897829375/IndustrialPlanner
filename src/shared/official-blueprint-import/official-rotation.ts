import type { EntityDefinition } from "@/domain/registry/types/entity-definition";
import type { GridEdge, GridPoint } from "@/domain/shared/grid";
import {
  resolveGridEdgeDelta,
  resolveRotatedPortGeometry,
} from "@/shared/geometry/port";
import type {
  QuarterRotation,
  RotationResolution,
} from "./official-types";

/**
 * 旋转求解器（双版本语义风险的安全网）。
 *
 * v6 注册表 rotation=0 = 官方默认朝向（AKEData 校准，Python 原型 318 锚点 +
 * 7 份蓝图连接数基线背书），主路径恒等 q = officialRot。v5 K 值表已结构性移除。
 *
 * 本模块在转换完成后做**校验性求解**：用平台注册表端口定义 + shared 几何原语，
 * 检查"与设备几何接触的物流格"是否全部被某端口的外侧格覆盖。
 * - 恒等覆盖全部接触 → identity-verified
 * - 恒等不覆盖，枚举 q∈{0,90,180,270} 找到唯一全覆盖解 → solver（仅报告，不自动改：
 *   改 rotation 会使已完成的物流端口接驳失效，显式报告由人工/开发者处置）
 * - 无唯一解 → fallback-identity + 警告
 */

/** 与设备几何接触的物流格证据。 */
export interface ContactEvidence {
  /** 接触格（平台坐标）。 */
  readonly cell: GridPoint;
  /** 物流种类（对应端口 isPipe）。 */
  readonly isPipe: boolean;
}

const QUARTER_ROTATIONS: readonly QuarterRotation[] = [0, 90, 180, 270];

interface PortGeometryAtRotation {
  readonly inside: GridPoint;
  readonly outside: GridPoint;
  readonly edge: GridEdge;
  readonly isPipe: boolean;
  readonly direction: "input" | "output" | "bidirectional";
}

function samePoint(a: GridPoint, b: GridPoint): boolean {
  return a.x === b.x && a.y === b.y;
}

/** 计算实体定义在指定 rotation 下的全部端口几何（含双向组展开为单向两端口）。 */
export function computePortGeometries(
  definition: EntityDefinition,
  position: GridPoint,
  rotation: QuarterRotation,
): PortGeometryAtRotation[] {
  const result: PortGeometryAtRotation[] = [];
  for (const group of definition.portGroups) {
    for (const port of group.ports) {
      const geometry = resolveRotatedPortGeometry({
        footprint: definition.footprint,
        port,
        rotation,
      });
      const inside = { x: position.x + geometry.cell.x, y: position.y + geometry.cell.y };
      const outside = { x: inside.x + geometry.delta.x, y: inside.y + geometry.delta.y };
      const directions: Array<"input" | "output"> = group.direction === "bidirectional"
        ? ["input", "output"]
        : [group.direction];
      for (const direction of directions) {
        result.push({
          inside,
          outside,
          edge: geometry.edge,
          isPipe: group.isPipe,
          direction,
        });
      }
    }
  }
  return result;
}

/** 指定 rotation 下端口几何是否覆盖全部接触证据（接触格 = 某同族端口的外侧格）。 */
function coversAllContacts(
  ports: readonly PortGeometryAtRotation[],
  contacts: readonly ContactEvidence[],
): boolean {
  return contacts.every((contact) =>
    ports.some(
      (port) => port.isPipe === contact.isPipe && samePoint(port.outside, contact.cell),
    ),
  );
}

/**
 * 校验设备的恒等旋转是否与邻接接触自洽。
 * 无接触证据（设备不接物流）或无端口定义时不具备校验条件。
 */
export function verifyDeviceRotation(options: {
  readonly entityId: string;
  readonly definition: EntityDefinition;
  readonly position: GridPoint;
  readonly officialRot: QuarterRotation;
  readonly contacts: readonly ContactEvidence[];
}): RotationResolution {
  const { entityId, definition, position, officialRot, contacts } = options;

  if (definition.portGroups.length === 0 || contacts.length === 0) {
    return {
      entityId,
      definitionId: definition.id,
      officialRot,
      chosenRot: officialRot,
      source: "identity-unverified",
    };
  }

  const coverageByRotation = new Map<QuarterRotation, boolean>();
  for (const candidate of QUARTER_ROTATIONS) {
    const ports = computePortGeometries(definition, position, candidate);
    coverageByRotation.set(candidate, coversAllContacts(ports, contacts));
  }

  if (coverageByRotation.get(officialRot) === true) {
    return {
      entityId,
      definitionId: definition.id,
      officialRot,
      chosenRot: officialRot,
      source: "identity-verified",
    };
  }

  const solutions = QUARTER_ROTATIONS.filter(
    (candidate) => coverageByRotation.get(candidate) === true,
  );
  if (solutions.length === 1) {
    return {
      entityId,
      definitionId: definition.id,
      officialRot,
      chosenRot: solutions[0]!,
      source: "solver",
    };
  }
  return {
    entityId,
    definitionId: definition.id,
    officialRot,
    chosenRot: officialRot,
    source: "fallback-identity",
  };
}

/** 物流节/物流设备的端口边（供邻接证据推断使用）。 */
export function rotatedPortEdge(edge: GridEdge, rotation: QuarterRotation): {
  edge: GridEdge;
  delta: GridPoint;
} {
  const geometry = resolveRotatedPortGeometry({
    footprint: { width: 1, height: 1 },
    port: { localCellX: 0, localCellY: 0, edge },
    rotation,
  });
  return { edge: geometry.edge, delta: resolveGridEdgeDelta(geometry.edge) };
}
