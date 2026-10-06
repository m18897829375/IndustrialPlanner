import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createRegistryContract } from "@/registry";
import {
  nodeAnchor,
  nodeOfficialRot,
  officialFootprintOrigin,
} from "@/shared/official-blueprint-import/official-anchor";
import { resolveOfficialDefinitionId } from "@/shared/official-blueprint-import/official-id-map";
import { LOGISTICS_TEMPLATE_KIND } from "@/shared/official-blueprint-import/official-logistics";
import {
  extractOfficialBlueprintData,
  type OfficialBlueprintNode,
} from "@/shared/official-blueprint-import/official-types";

/**
 * 锚点回归（verify_anchors.py 的 TS 移植）：
 * 对每份官方蓝图的非物流节点，用"锚点表 + 平台注册表 footprint"反推官方占地左上角，
 * 其中心必须与官方 interactiveParam.position（占地中心）一致（容差 0.01）。
 * 这是"免平台验证"的核心手段：锚点表 × 尺寸表 × 恒等旋转联合正确的实证。
 */

const FIXTURE_FILES = [
  "bp_simple",
  "bp_test",
  "bp_user",
  "bp_EF0108131aE82iAIE179",
  "bp_EF013Eou8uo47auUu0579",
  "bp_EF01I43ouo3OA979O5o08",
  "bp_EF0170iUeUi6855u2O0Ai",
  "bp_EF010819a91uOi12iE179",
] as const;

const TOLERANCE = 0.01;

function loadFixture(name: string): OfficialBlueprintNode[] {
  const raw = JSON.parse(
    readFileSync(`src/tests/fixtures/official/${name}.json`, "utf8"),
  ) as unknown;
  return [...extractOfficialBlueprintData(raw).nodes];
}

describe("官方蓝图锚点回归（interactiveParam 中心一致性）", () => {
  const registry = createRegistryContract();

  for (const fixtureName of FIXTURE_FILES) {
    it(`${fixtureName}: 全部非物流节点锚点→占地中心一致`, () => {
      const nodes = loadFixture(fixtureName);
      const failures: string[] = [];
      let checked = 0;
      let skippedNode = 0;

      for (const node of nodes) {
        if (LOGISTICS_TEMPLATE_KIND[node.templateId] !== undefined) continue;
        const resolved = resolveOfficialDefinitionId(node.templateId, node.coms, registry);
        if (resolved === null) {
          skippedNode++;
          continue;
        }
        const definition = registry.queries.findEntityDefinition(resolved.definitionId);
        if (definition === null) {
          skippedNode++;
          continue;
        }
        const ip = node.transform?.interactiveParam?.position;
        if (ip === undefined) {
          skippedNode++;
          continue;
        }

        const rot = nodeOfficialRot(node);
        const { ax, az } = nodeAnchor(node);
        const footprint = officialFootprintOrigin(
          ax,
          az,
          rot,
          definition.footprint.width,
          definition.footprint.height,
        );
        const centerX = footprint.x0 + footprint.w / 2;
        const centerZ = footprint.z0 + footprint.h / 2;

        if (
          Math.abs(centerX - ip.x) > TOLERANCE
          || Math.abs(centerZ - ip.z) > TOLERANCE
        ) {
          failures.push(
            `nodeId=${node.nodeId} ${node.templateId}→${resolved.definitionId} rot=${rot}: `
            + `推导中心(${centerX},${centerZ}) ≠ 官方ip(${ip.x},${ip.z})`,
          );
        }
        checked++;
      }

      expect(
        failures,
        `${fixtureName} 锚点失配 ${failures.length}/${checked}:\n${failures.slice(0, 10).join("\n")}`,
      ).toEqual([]);
      expect(checked).toBeGreaterThan(0);
      console.log(
        `   [anchors] ${fixtureName}: ${checked} 节点一致，${skippedNode} 跳过（无 ip/未注册）`,
      );
    });
  }
});
