import { describe, expect, it } from "vitest";

import { createRegistryContract } from "@/registry";
import {
  convertOfficialBlueprint,
  extractOfficialBlueprintData,
} from "@/shared/official-blueprint-import";

/**
 * F2 单格物流段方向解析规则（声明优先）单测。
 * 证据链：游戏 ConveyorSpatialInfo/ExtraInfo（IL2CPP dump）+ BlueprintPreview.lua
 * 拐角渲染（startFace/endFace）+ D.I.G.E. 生成器写入约定 → 单格段方向由官方
 * (directionIn, directionOut) 声明，直连采用，不做邻接猜测；断头只审计不改写。
 */

interface BeltNodeSpec {
  nodeId: number;
  /** 平台坐标 (x, y)。 */
  x: number;
  y: number;
  dInY?: number;
  dOutY?: number;
  /** 折线第二个点（平台坐标；缺省 = 与首点相同的单格）。 */
  x2?: number;
  y2?: number;
}

function makeBlueprint(nodes: BeltNodeSpec[], zSize = 8): unknown {
  const zMax = zSize - 1;
  // 裸 bluePrintData（extractOfficialBlueprintData 直接识别顶层 nodes）
  return {
    name: "synthetic",
    desc: "",
    xSize: 12,
    zSize,
    nodes: nodes.map((n) => ({
      templateId: "grid_belt_01",
      productIcon: "",
      nodeId: n.nodeId,
      transform: {
        directionIn: n.dInY !== undefined ? { x: 0, y: n.dInY, z: 0 } : null,
        directionOut: n.dOutY !== undefined ? { x: 0, y: n.dOutY, z: 0 } : null,
        points: [
          { x: n.x, y: 0, z: zMax - n.y },
          { x: n.x2 ?? n.x, y: 0, z: zMax - (n.y2 ?? n.y) },
        ],
      },
      coms: [],
    })),
  };
}

function convert(raw: unknown) {
  return convertOfficialBlueprint(extractOfficialBlueprintData(raw), {
    registry: createRegistryContract(),
    now: "2026-01-01T00:00:00.000Z",
    blueprintId: "test-single-cell",
  });
}

describe("F2 单格物流段方向解析（声明优先）", () => {
  it("声明直行：dIn=dOut=90(y) → 平台 straight E(0)", () => {
    const { doc } = convert(makeBlueprint([
      { nodeId: 1, x: 3, y: 3, dInY: 90, dOutY: 90 },
    ]));
    const belt = doc.entities["logistics-draft:belt:3:3"]!;
    expect(belt.definitionId).toBe("belt_straight_1x1");
    expect(belt.rotation).toBe(0);
  });

  it("声明转弯：dIn=180,dOut=90 → 平台 dIn=N(270),dOut=E(0) → turn_cw rot=90", () => {
    const { doc } = convert(makeBlueprint([
      { nodeId: 1, x: 3, y: 3, dInY: 180, dOutY: 90 },
    ]));
    const belt = doc.entities["logistics-draft:belt:3:3"]!;
    expect(belt.definitionId).toBe("belt_turn_cw_1x1");
    expect(belt.rotation).toBe(90);
  });

  it("声明断头：出向无对接 → 忠实采用声明 + divergence 审计记录（不改写）", () => {
    const { doc, report } = convert(makeBlueprint([
      { nodeId: 1, x: 3, y: 3, dInY: 90, dOutY: 90 }, // 出向 E，(4,3) 空
    ]));
    const belt = doc.entities["logistics-draft:belt:3:3"]!;
    expect(belt.rotation).toBe(0); // 声明不被改写
    expect(report.directionDivergences.some((d) => d.includes("(3,3)") && d.includes("E(0)"))).toBe(true);
  });

  it("声明出向命中同族物流格 → 无审计记录", () => {
    const { report } = convert(makeBlueprint([
      // 多格段 [(4,3),(5,3)] 流 E；单格 (3,3) 出向 E 命中 (4,3)
      { nodeId: 1, x: 4, y: 3, x2: 5, y2: 3 },
      { nodeId: 2, x: 3, y: 3, dInY: 90, dOutY: 90 },
    ]));
    expect(report.directionDivergences).toEqual([]);
  });

  it("无声明字段：回退邻接推断，缺邻接时兜底 E(0)", () => {
    const { doc } = convert(makeBlueprint([
      { nodeId: 1, x: 3, y: 3 }, // 无 dIn/dOut，孤立格
    ]));
    const belt = doc.entities["logistics-draft:belt:3:3"]!;
    expect(belt.definitionId).toBe("belt_straight_1x1");
    expect(belt.rotation).toBe(0);
  });
});
