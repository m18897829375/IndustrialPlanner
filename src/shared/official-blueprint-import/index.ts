import {
  createBlueprintDocument,
} from "@/domain/document/blueprint-document";
import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { GridRectSize } from "@/domain/shared/grid";
import { resolveRotatedPortGeometry } from "@/shared/geometry/port";
import {
  nodeAnchor,
  nodeOfficialRot,
  officialFootprintOrigin,
  rotatedSize,
  toPlatformPosition,
} from "./official-anchor";
import { buildOfficialConfig } from "./official-config";
import {
  allocateEntityId,
  createConverterContext,
  type ConverterContext,
} from "./official-context";
import {
  applyEdgeSidecar,
  buildExplicitEdgeTable,
} from "./official-edge-table";
import { resolveOfficialDefinitionId } from "./official-id-map";
import {
  convertLogistics,
  LOGISTICS_TEMPLATE_KIND,
} from "./official-logistics";
import { adaptLineEndpoints } from "./official-port-adaptation";
import { upgradeTeeJunctions } from "./official-tee-upgrade";
import {
  verifyDeviceRotation,
  type ContactEvidence,
} from "./official-rotation";
import { checkImportTopology } from "./official-topology-check";
import type {
  ConvertOptions,
  ConvertReport,
  ConvertResult,
  OfficialBlueprintData,
  RotationResolution,
} from "./official-types";

export * from "./official-types";
export * from "./official-edge-table";
export { extractOfficialBlueprintData } from "./official-types";

/**
 * 官方蓝图导入器编排器（转换流水线）：
 *   convertDevice（恒等旋转）→ convertLogistics（两遍法）→ adaptLineEndpoints（端口接驳）
 *   → rotationVerification（求解器校验）→ checkImportTopology（平台本尊连通自检）
 *   → createBlueprintDocument（schema 6）
 */
export function convertOfficialBlueprint(
  json: OfficialBlueprintData,
  options: ConvertOptions & { registry: RegistryContract },
): ConvertResult {
  const { registry, ...convertOptions } = options;
  const ctx = createConverterContext(registry, json.zSize, convertOptions);

  // [1] 设备（按 nodeId 排序，跳过物流节点）
  const sortedNodes = [...json.nodes].sort((a, b) => a.nodeId - b.nodeId);
  for (const node of sortedNodes) {
    if (LOGISTICS_TEMPLATE_KIND[node.templateId] !== undefined) continue;
    convertDevice(ctx, node);
  }

  // [2] 物流展开（两遍法）
  convertLogistics(ctx, sortedNodes);

  // [3] 端口接驳（E 规则）
  adaptLineEndpoints(ctx, sortedNodes);

  // [3.5] T 型汇入升级（设备 output 侧向注入带/管 → converger）
  upgradeTeeJunctions(ctx);

  // [4] 旋转求解器校验（诊断安全网；不自动改 rotation）
  const rotationResolutions = verifyRotations(ctx);
  for (const resolution of rotationResolutions) {
    if (resolution.source === "solver") {
      ctx.warnings.push(
        `⚠️ ${resolution.entityId}(${resolution.definitionId}): 恒等旋转 ${resolution.officialRot}° 与邻接端口不符，`
        + `求解建议 ${resolution.chosenRot}°（未自动应用，请人工核对）`,
      );
    } else if (resolution.source === "fallback-identity") {
      ctx.warnings.push(
        `⚠️ ${resolution.entityId}(${resolution.definitionId}): 旋转 ${resolution.officialRot}° 无法与邻接端口自洽，`
        + `枚举求解不唯一，已回退恒等（请人工核对）`,
      );
    }
  }

  // [5] 拓扑自检（平台本尊 compilePhysicalConnections）
  const topologyCheck = checkImportTopology(ctx);

  // [5.5] 供应缺口检测：反应池液体输入无来源（平台需暗管取液口显式供液，游戏内为仓库直供）
  detectFluidSupplyGaps(ctx);

  // [6] 文档落库（内嵌显式边表：推断边 + 可选 sidecar 人工修正合并；
  //     仿真编译时边表在场即权威，详见 simulation/topology/explicit-connections.ts）
  const finalEdges = options.edgeSidecar !== undefined
    ? applyEdgeSidecar(topologyCheck.connections, options.edgeSidecar)
    : topologyCheck.connections;
  const logisticsEdges = buildExplicitEdgeTable({
    edges: finalEdges,
    blueprintCode: options.blueprintCode ?? "",
    sourceHash: options.blueprintSourceHash ?? "",
    zMax: ctx.zMax,
    disabled: options.edgeSidecar?.disabled ?? [],
  });
  const doc = createBlueprintDocument({
    ...(options.blueprintId !== undefined ? { blueprintId: options.blueprintId } : {}),
    name: json.name ?? "未命名蓝图",
    description: json.desc ?? "",
    baseId: ctx.options.baseId,
    initialGridPoint: computeInitialGridPoint(ctx),
    entities: ctx.entities,
    entityOrder: ctx.order,
    slotLinks: ctx.slotLinks,
    logisticsEdges,
    ...(options.now !== undefined ? { createdAt: options.now, updatedAt: options.now } : {}),
  });

  const hasHongsBus = ctx.order.some((eid) => {
    const definitionId = ctx.entities[eid]!.definitionId;
    return definitionId === "log_hongs_bus" || definitionId === "log_hongs_bus_source";
  });

  const report: ConvertReport = {
    entityCount: ctx.order.length,
    deviceCount: ctx.devMeta.size,
    logisticsCount: ctx.logiMeta.size,
    slotLinkCount: ctx.slotLinks.length,
    skipped: ctx.skipped,
    warnings: [...ctx.warnings, ...topologyCheck.unconnectedPortWarnings],
    notes: ctx.notes,
    rotationResolutions,
    topologyCheck,
    ...(hasHongsBus
      ? { baseIdSuggestion: "蓝图含洪斯总线，valley4 基地内置同款；当前使用 wuling_protocol_core" }
      : {}),
  };

  return { doc, report };
}

function convertDevice(
  ctx: ConverterContext,
  node: import("./official-types").OfficialBlueprintNode,
): void {
  const resolved = resolveOfficialDefinitionId(node.templateId, node.coms, ctx.registry);
  if (resolved === null) {
    ctx.skipped.push({ templateId: node.templateId, reason: "注册表无此实体" });
    return;
  }
  const { definitionId, mode } = resolved;
  const definition = ctx.registry.queries.findEntityDefinition(definitionId)!;

  const rotOfficial = nodeOfficialRot(node);
  const { ax, az } = nodeAnchor(node);
  const footprint = officialFootprintOrigin(
    ax,
    az,
    rotOfficial,
    definition.footprint.width,
    definition.footprint.height,
  );
  const position = toPlatformPosition(footprint, ctx.zMax);
  // v6 注册表 rotation=0 = 官方默认朝向：旋转恒等（v5 K 值表已结构性移除）
  const rotation = rotOfficial;

  const entityId = allocateEntityId(ctx, definitionId);
  const { config, slotLinks } = buildOfficialConfig(ctx, node, definition, entityId, mode);

  ctx.entities[entityId] = {
    id: entityId,
    definitionId,
    position,
    rotation,
    config,
    tags: [],
  };
  ctx.order.push(entityId);
  ctx.slotLinks.push(...slotLinks);
  ctx.devMeta.set(entityId, {
    definitionId,
    x: position.x,
    y: position.y,
    rotOfficial,
    w: footprint.w,
    h: footprint.h,
    templateId: node.templateId,
  });
}

/** 旋转校验：收集每台设备端口外侧格的物流接触证据，逐个跑求解器。 */
function verifyRotations(ctx: ConverterContext): RotationResolution[] {
  const resolutions: RotationResolution[] = [];
  for (const [entityId, meta] of ctx.devMeta) {
    const definition = ctx.registry.queries.findEntityDefinition(meta.definitionId);
    if (definition === null) continue;
    const contacts: ContactEvidence[] = [];
    for (const group of definition.portGroups) {
      for (const port of group.ports) {
        const geometry = resolveRotatedPortGeometry({
          footprint: definition.footprint,
          port,
          rotation: meta.rotOfficial,
        });
        const outside = {
          x: meta.x + geometry.cell.x + geometry.delta.x,
          y: meta.y + geometry.cell.y + geometry.delta.y,
        };
        const kind = group.isPipe ? "pipe" : "belt";
        if (ctx.cellOwner.has(`${kind}:${outside.x}:${outside.y}`)) {
          contacts.push({ cell: outside, isPipe: group.isPipe });
        }
      }
    }
    resolutions.push(verifyDeviceRotation({
      entityId,
      definition,
      position: { x: meta.x, y: meta.y },
      officialRot: meta.rotOfficial,
      contacts,
    }));
  }
  return resolutions;
}

/**
 * 缺液检测：mix_pool 的 fluid_input 端口组无管道连接时，其全部配方（均含液体原料）
 * 在当前平台语义下不会启动（游戏内仓库直供液体，平台需暗管取液口显式供液）。
 * 显式警告而非静默（转换报告驱动用户知晓）。
 */
function detectFluidSupplyGaps(ctx: ConverterContext): void {
  for (const [entityId, meta] of ctx.devMeta) {
    if (meta.definitionId !== "mix_pool_1" && meta.definitionId !== "mix_pool_2") continue;
    const definition = ctx.registry.queries.findEntityDefinition(meta.definitionId);
    if (definition === null) continue;
    let hasFluidConnection = false;
    for (const group of definition.portGroups) {
      if (group.direction !== "input" || !group.isPipe) continue;
      for (const port of group.ports) {
        const geometry = resolveRotatedPortGeometry({
          footprint: definition.footprint,
          port,
          rotation: meta.rotOfficial,
        });
        const outside = {
          x: meta.x + geometry.cell.x + geometry.delta.x,
          y: meta.y + geometry.cell.y + geometry.delta.y,
        };
        if (ctx.cellOwner.has(`pipe:${outside.x}:${outside.y}`)) {
          hasFluidConnection = true;
          break;
        }
      }
      if (hasFluidConnection) break;
    }
    if (!hasFluidConnection) {
      ctx.warnings.push(
        `⚠️ ${entityId}(${meta.definitionId}): 液体输入端口无管道连接——反应池配方均含液体原料，`
        + `平台语义下不会启动（游戏内为仓库直供液体，平台需暗管取液口显式供液）`,
      );
    }
  }
}

/** initialGridPoint = 全部实体旋转后 footprint 包围盒中心（取整）。 */
function computeInitialGridPoint(ctx: ConverterContext): { x: number; y: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const eid of ctx.order) {
    const entity = ctx.entities[eid]!;
    const definition = ctx.registry.queries.findEntityDefinition(entity.definitionId);
    const baseSize: GridRectSize = definition?.footprint ?? { width: 1, height: 1 };
    const size = rotatedSize(baseSize, entity.rotation as 0 | 90 | 180 | 270);
    minX = Math.min(minX, entity.position.x);
    minY = Math.min(minY, entity.position.y);
    maxX = Math.max(maxX, entity.position.x + size.width - 1);
    maxY = Math.max(maxY, entity.position.y + size.height - 1);
  }
  if (!Number.isFinite(minX)) {
    return { x: 0, y: 0 };
  }
  return {
    x: Math.round((minX + maxX) / 2),
    y: Math.round((minY + maxY) / 2),
  };
}
