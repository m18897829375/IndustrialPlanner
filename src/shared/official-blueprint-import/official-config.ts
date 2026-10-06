import type { EntityDefinition } from "@/domain/registry/types/entity-definition";
import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { SlotLinkDefinition } from "@/domain/shared/slot-link";
import type { ConverterContext } from "./official-context";
import type {
  OfficialBlueprintNode,
  OfficialCom,
} from "./official-types";

/**
 * 设备功能配置生成（移植自 convert_v5.py build_config + 方案补漏）。
 *
 * 合并规则：base = placementDefaults 展开（自动覆盖 storager warehouse_submit、
 * mix_pool automaticMode 等，与编辑器放置行为一致），官方数据推导的配置按键级
 * 覆盖（channelRecipes 做子键合并，避免冲掉 defaults 的 warehouse_submit）。
 */

const PLACEMENT_SELF = "[Self]";

/** placementDefaults 展开（契约同 placement-action.ts:465 expandPlacementDefaults）。 */
export function expandPlacementDefaultsLocal(
  definition: EntityDefinition,
  entityId: string,
): { config: Record<string, unknown>; slotLinks: SlotLinkDefinition[] } {
  const defaults = definition.placementDefaults;
  return {
    config: defaults?.config !== undefined ? { ...defaults.config } : {},
    slotLinks: (defaults?.slotLinks ?? []).map((link) => ({
      ...link,
      id: link.id.replaceAll(PLACEMENT_SELF, entityId),
      source: {
        ...link.source,
        entityId: link.source.entityId.replaceAll(PLACEMENT_SELF, entityId),
      },
    })),
  };
}

function findSelectorItemId(coms: readonly OfficialCom[] | undefined): string | null {
  for (const com of coms ?? []) {
    const itemId = com.selector?.selectedItemId;
    if (itemId !== undefined && itemId !== "") {
      return itemId;
    }
  }
  return null;
}

function findValve(coms: readonly OfficialCom[] | undefined): {
  itemId: string;
  valveEnable: boolean;
} | null {
  for (const com of coms ?? []) {
    const valve = com.boxValve ?? com.fluidValve;
    if (valve !== undefined && valve.selectedItemId !== undefined && valve.selectedItemId !== "") {
      return { itemId: valve.selectedItemId, valveEnable: valve.valveEnable ?? false };
    }
  }
  return null;
}

/**
 * mix_pool 输出选择器（实证语义，2026-09-22 官方数据普查修正）：
 *   - comPos 61：固体（皮带）输出口选择器，值为固体物品（产物或原料，以蓝图记录为准）
 *   - comPos 62..66：液体（管道）输出口选择器（coms 数组顺序不稳定，必须按 comPos 排序）
 * 另：comPos 37 / comType 35 空组件（mix_pool_2 全部、部分 mix_pool_1 有）语义未解，不处理。
 */
export interface MixPoolSelectors {
  /** 固体口选择物品（comPos 61），未配置为 null。 */
  readonly solidItemId: string | null;
  /** 液体口选择物品（comPos 62..66 按 comPos 顺序的非空物品）。 */
  readonly fluidItemIds: readonly string[];
}

export function collectMixPoolSelectors(
  coms: readonly OfficialCom[] | undefined,
): MixPoolSelectors {
  let solidItemId: string | null = null;
  const fluidItems: Array<{ pos: number; itemId: string }> = [];
  for (const com of coms ?? []) {
    const pos = com.comPos ?? 0;
    const itemId = com.selector?.selectedItemId;
    if (itemId === undefined || itemId === "") continue;
    if (pos === 61) {
      solidItemId = itemId;
    } else if (pos >= 62 && pos <= 66) {
      fluidItems.push({ pos, itemId });
    }
  }
  fluidItems.sort((a, b) => a.pos - b.pos);
  return { solidItemId, fluidItemIds: fluidItems.map((f) => f.itemId) };
}

/**
 * 配方匹配：selector 集合 ⊆ 配方 outputs 优先；无完全包含时取交集最大者。
 * 返回 { recipeId, fullyCovered } 或 null（无任何交集）。
 */
export function matchRecipeBySelectorSet(
  registry: RegistryContract,
  definitionId: string,
  selectorItems: readonly string[],
): { recipeId: string; fullyCovered: boolean } | null {
  if (selectorItems.length === 0) return null;
  const itemSet = new Set(selectorItems);
  const recipes = registry.queries.findRecipeDefinitionsByMachine(definitionId);

  const fullyCovering = recipes.filter((recipe) =>
    [...itemSet].every((item) => recipe.outputs.some((output) => output.itemId === item)),
  );
  if (fullyCovering.length > 0) {
    return { recipeId: fullyCovering[0]!.id, fullyCovered: true };
  }

  let bestId: string | null = null;
  let bestOverlap = 0;
  for (const recipe of recipes) {
    const overlap = [...itemSet].filter(
      (item) => recipe.outputs.some((output) => output.itemId === item),
    ).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestId = recipe.id;
    }
  }
  return bestId === null ? null : { recipeId: bestId, fullyCovered: false };
}

/**
 * 配方匹配：在设备已注册配方中找 outputs 包含目标物品者；
 * mode 命中时优先 id 含 `_${mode}` 或 tags 含 mode 的配方。
 */
export function matchRecipeByProduct(
  registry: RegistryContract,
  definitionId: string,
  productItemId: string,
  mode: string | null,
): string | null {
  const candidates = registry.queries
    .findRecipeDefinitionsByMachine(definitionId)
    .filter((recipe) => recipe.outputs.some((output) => output.itemId === productItemId));
  if (candidates.length === 0) {
    return null;
  }
  if (mode !== null) {
    const preferred = candidates.find(
      (recipe) => recipe.id.includes(`_${mode}`) || recipe.tags.includes(mode),
    );
    if (preferred !== undefined) {
      return preferred.id;
    }
  }
  return candidates[0]!.id;
}

/** config 合并：channelRecipes 子键合并，其余顶层键官方推导覆盖 defaults。 */
function mergeConfig(
  base: Record<string, unknown>,
  derived: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(derived)) {
    if (
      key === "channelRecipes"
      && typeof value === "object" && value !== null
      && typeof merged[key] === "object" && merged[key] !== null
    ) {
      merged[key] = { ...(merged[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function buildOfficialConfig(
  ctx: ConverterContext,
  node: OfficialBlueprintNode,
  definition: EntityDefinition,
  entityId: string,
  mode: string | null,
): { config: Record<string, unknown>; slotLinks: SlotLinkDefinition[] } {
  const { config: baseConfig, slotLinks: baseLinks } = expandPlacementDefaultsLocal(definition, entityId);
  const derived: Record<string, unknown> = {};
  const links: SlotLinkDefinition[] = [...baseLinks];
  const coms = node.coms;

  // —— unloader：仓库 slotLink + ignoreStock ——
  if (definition.id === "unloader_1") {
    const itemId = findSelectorItemId(coms);
    if (itemId !== null) {
      const link = ctx.registry.queries.buildWarehouseSlotLinkForEntity({
        entityId,
        storageSlotGroupId: "unloader_buffer",
        slotId: "slot_1",
        itemId,
      });
      links.push({ ...link, id: `warehouse-link:${entityId}:unloader_buffer:slot_1` });
      if (ctx.options.infiniteSupply) {
        derived["storageSlotGroups[0].slots[0].ignoreStock"] = true;
      }
      ctx.notes.push(`${entityId}: 取货口→仓库链接 ${itemId}`);
    }
  }

  // —— 准入口：阀门 acceptRule + admissionRule ——
  if (definition.id === "log_admission" || definition.id === "pipe_admission") {
    const valve = findValve(coms);
    if (valve !== null) {
      derived["portGroups[0].ports[0].acceptRule"] = {
        base: { kind: "item", itemId: valve.itemId },
        exclude: [],
      };
      derived["portGroups[0].ports[0].admissionRule"] = {
        itemId: valve.valveEnable ? valve.itemId : null,
        limit: null,
        perMinuteLimit: null,
      };
      ctx.notes.push(`${entityId}: 准入口材料 ${valve.itemId} (valveEnable=${valve.valveEnable})`);
    }
  }

  // —— mix_pool：输出端口按 selector 写 item 级白名单 + channelRecipes.ch1 ——
  // （recipeChannelAutomaticModeEnabled 已由 placementDefaults 覆盖，不重复写）
  // 严格按蓝图原本的输出规则：selector 记录什么物品就放什么物品（item 级）。
  // 未配置的输出组保持注册表 none（不出货）→ 原料不在白名单，根除原料直通。
  if (definition.id === "mix_pool_1" || definition.id === "mix_pool_2") {
    const selectors = collectMixPoolSelectors(coms);
    const selectorAll = [
      ...(selectors.solidItemId !== null ? [selectors.solidItemId] : []),
      ...selectors.fluidItemIds,
    ];

    // 固体输出口组（item_output）：comPos 61 物品 → 组内全部端口 item 级白名单
    if (selectors.solidItemId !== null) {
      for (const [groupIndex, group] of definition.portGroups.entries()) {
        if (group.id !== "item_output") continue;
        for (const [portIndex] of group.ports.entries()) {
          derived[`portGroups[${groupIndex}].ports[${portIndex}].acceptRule`] = {
            base: { kind: "item", itemId: selectors.solidItemId },
            exclude: [],
          };
        }
      }
    }

    // 液体输出口组（fluid_output_a/b）：comPos 62-66 物品按序分配，各组全部端口写白名单
    const fluidOutputGroupIds = definition.portGroups
      .filter((group) => group.direction === "output" && group.isPipe)
      .map((group) => group.id);
    for (const [index, itemId] of selectors.fluidItemIds.entries()) {
      const targetGroupId = fluidOutputGroupIds[index];
      if (targetGroupId === undefined) {
        ctx.warnings.push(
          `⚠️ ${entityId}: 液体输出选择器物品 ${itemId} 超出平台液体输出口数（${fluidOutputGroupIds.length}），未配置`,
        );
        continue;
      }
      for (const [groupIndex, group] of definition.portGroups.entries()) {
        if (group.id !== targetGroupId) continue;
        for (const [portIndex] of group.ports.entries()) {
          derived[`portGroups[${groupIndex}].ports[${portIndex}].acceptRule`] = {
            base: { kind: "item", itemId },
            exclude: [],
          };
        }
      }
    }

    // 配方意图记录：selector 集合匹配配方写 channelRecipes.ch1。
    // 注意：automaticMode=true 时运行时忽略 channelRecipes（defaultRecipeId 仅手动模式读取），
    // 此处仅作蓝图配方意图记录与手动模式兜底。
    if (selectorAll.length > 0) {
      const matched = matchRecipeBySelectorSet(ctx.registry, definition.id, selectorAll);
      if (matched !== null) {
        derived["channelRecipes"] = { ch1: matched.recipeId };
        if (!matched.fullyCovered) {
          ctx.warnings.push(
            `⚠️ ${entityId}: selector 物品集合跨配方混合（${selectorAll.join(",")}），`
            + `按最大交集匹配 ${matched.recipeId}`,
          );
        } else {
          ctx.notes.push(`${entityId}: 反应池配方 ${matched.recipeId}（selector=${selectorAll.join(",")}）`);
        }
      } else {
        ctx.warnings.push(
          `⚠️ ${entityId}: selector 物品集合（${selectorAll.join(",")}）无匹配配方`,
        );
      }
    }
  }

  // —— 生产机：productIcon → 配方匹配 → channelRecipes.default ——
  // 前置条件对齐 Python 白名单语义（def_id in recipes）：仅"注册表有配方"的设备参与匹配，
  // 否则 productIcon 只是展示图标（如准入口显示阀门物品），不做匹配也不警告。
  const product = node.productIcon ?? "";
  if (
    product !== ""
    && definition.recipeChannels.some((channel) => channel.id === "default")
    && ctx.registry.queries.findRecipeDefinitionsByMachine(definition.id).length > 0
  ) {
    const recipeId = matchRecipeByProduct(ctx.registry, definition.id, product, mode);
    if (recipeId !== null) {
      derived["channelRecipes"] = {
        ...(derived["channelRecipes"] as Record<string, unknown> | undefined),
        default: recipeId,
      };
      ctx.notes.push(`${entityId}: 配方 ${recipeId} (product=${product}, mode=${mode ?? "-"})`);
    } else {
      ctx.warnings.push(`⚠️ ${entityId}: 配方未匹配 product=${product} mode=${mode ?? "-"}，留默认`);
    }
  }

  return { config: mergeConfig(baseConfig, derived), slotLinks: links };
}
