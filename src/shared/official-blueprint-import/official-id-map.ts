import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { OfficialCom } from "./official-types";

/**
 * 官方 templateId → 平台 definitionId 别名表。
 * 源：.agents/skills/unpack-data-analysis/scripts/device-building-aliases.mjs
 * 的 RAW_BUILDING_ID_BY_PROJECT_ID（该文件为离线分析脚本，运行时不可 import，
 * 此处转录为 TS 常量，目标名使用 v6 注册表命名）。
 */
export const OFFICIAL_TO_PLATFORM_ID: Readonly<Record<string, string>> = {
  component_mc_1: "cmpt_mc_1",
  tools_assebling_mc_1: "tools_asm_mc_1",
  power_station_1: "power_sta_1",
  log_conditioner: "log_admission",
  log_pipe_conditioner: "pipe_admission",
  // 降级：布局一致，仅供电范围差异
  power_diffuser_2: "power_diffuser_1",
  log_pipe_splitter: "pipe_splitter",
  log_pipe_converger: "pipe_converger",
  log_pipe_connector: "pipe_connector",
  seedcollector_1: "seedcol_1",
};

/**
 * 官方"基机 + formulaMan.curMode=liquid" → 平台独立液体变体实体（v6 命名）。
 * 官方基机同时承担固体/液体两种产线；平台注册表将其拆为独立定义。
 */
const LIQUID_VARIANT_BY_BASE_ID: Readonly<Record<string, string>> = {
  furnance_1: "furnance_1_liquid",
  planter_1: "planter_1_liquid",
};

export interface ResolvedDefinitionId {
  readonly definitionId: string;
  /** 官方配方模式（formulaMan.curMode），配方匹配时优先。 */
  readonly mode: string | null;
}

/**
 * 解析官方节点 → 平台 definitionId。
 * 依次应用：模式变体分流（liquid）→ ID 别名表 → 注册表存在性校验。
 * 注册表查无此实体时返回 null（由调用方计入 skipped，不中断转换）。
 */
export function resolveOfficialDefinitionId(
  templateId: string,
  coms: readonly OfficialCom[] | undefined,
  registry: RegistryContract,
): ResolvedDefinitionId | null {
  let mode: string | null = null;
  for (const com of coms ?? []) {
    const curMode = com.formulaMan?.curMode;
    if (curMode !== undefined && curMode !== "") {
      mode = curMode;
    }
  }

  let definitionId = OFFICIAL_TO_PLATFORM_ID[templateId] ?? templateId;
  if (mode === "liquid") {
    const liquidVariant = LIQUID_VARIANT_BY_BASE_ID[templateId];
    if (liquidVariant !== undefined) {
      definitionId = liquidVariant;
    }
  }

  if (registry.queries.findEntityDefinition(definitionId) === null) {
    return null;
  }
  return { definitionId, mode };
}
