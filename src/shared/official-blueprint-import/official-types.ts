import type { BlueprintDocument } from "@/domain/document/blueprint-document";
import type { EdgeSourcePort, ExplicitEdge, ExplicitEdgeTable } from "./official-edge-table";

/**
 * 官方蓝图解析 JSON 类型（熵增 API `data.data.bluePrintData` 载荷）。
 * 仅声明转换器实际读取的字段；未知字段原样忽略。
 */

export interface OfficialVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface OfficialCom {
  readonly comPos?: number;
  readonly comType?: number;
  readonly selector?: {
    readonly selectedItemId?: string;
  };
  readonly boxValve?: {
    readonly selectedItemId?: string;
    readonly valveEnable?: boolean;
    readonly valvePassed?: number;
  };
  readonly fluidValve?: {
    readonly selectedItemId?: string;
    readonly valveEnable?: boolean;
    readonly valvePassed?: number;
  };
  readonly formulaMan?: {
    readonly curMode?: string;
  };
}

export interface OfficialTransform {
  /** 设备锚点格（官方语义：随旋转的角落格）。物流节点无此字段。 */
  readonly position?: OfficialVec3;
  /** 官方朝向；可能缺失（此时回退 direction）。 */
  readonly rotation?: OfficialVec3 | null;
  /** 朝向 fallback；rotation 缺失时使用其 y 分量。 */
  readonly direction?: OfficialVec3 | null;
  /** 物流节点折线（顺序 = 流向）；y 为高度层（带 0 / 管 3，转换丢弃）。 */
  readonly points?: readonly OfficialVec3[];
  readonly directionIn?: OfficialVec3 | null;
  readonly directionOut?: OfficialVec3 | null;
  /** 官方给定的占地中心（x/z 为 .5 结尾的浮点中心）。锚点回归校验用。 */
  readonly interactiveParam?: {
    readonly position?: OfficialVec3;
    readonly rotation?: OfficialVec3;
    readonly properties?: Record<string, unknown>;
  } | null;
}

export interface OfficialBlueprintNode {
  readonly nodeId: number;
  readonly templateId: string;
  readonly productIcon?: string;
  readonly coms?: readonly OfficialCom[];
  readonly transform?: OfficialTransform;
}

export interface OfficialBlueprintData {
  readonly name?: string;
  readonly desc?: string;
  readonly xSize: number;
  readonly zSize: number;
  readonly nodes: readonly OfficialBlueprintNode[];
}

/** 从完整 API 响应（含信封）或裸 bluePrintData 中提取布局数据。 */
export function extractOfficialBlueprintData(
  raw: unknown,
): OfficialBlueprintData {
  const envelope = raw as {
    data?: { data?: { bluePrintData?: unknown } };
  };
  const nested = envelope?.data?.data?.bluePrintData;
  if (nested !== undefined && nested !== null) {
    return nested as OfficialBlueprintData;
  }
  const direct = raw as OfficialBlueprintData;
  if (
    direct !== null
    && typeof direct === "object"
    && Array.isArray((direct as { nodes?: unknown }).nodes)
  ) {
    return direct;
  }
  throw new Error("无法识别的官方蓝图 JSON：缺少 data.data.bluePrintData 或 nodes");
}

export interface ConvertOptions {
  /** 基地 ID，默认 wuling_protocol_core。 */
  readonly baseId?: string;
  /** 取货口是否开无限供应（默认 true，便于演示）。 */
  readonly infiniteSupply?: boolean;
  /** 文档创建时间注入（测试可复现）。 */
  readonly now?: string;
  /** 蓝图 ID 注入（测试可复现）。 */
  readonly blueprintId?: string;
  /** 源蓝图码（写入内嵌边表，供溯源；可选）。 */
  readonly blueprintCode?: string;
  /** 源蓝图原文 sha256（写入内嵌边表，供失配检测；可选）。 */
  readonly blueprintSourceHash?: string;
  /** 人工修正边表 sidecar（合并进内嵌边表：disabled 禁边、manual 追加）。 */
  readonly edgeSidecar?: ExplicitEdgeTable;
}

export type RotationResolutionSource =
  /** v6 注册表 rotation=0 = 官方默认朝向，恒等采用且端口边校验通过。 */
  | "identity-verified"
  /** 恒等采用，但无足够数据校验（无端口设备或无邻接信息）。 */
  | "identity-unverified"
  /** 恒等校验失败，枚举 q∈{0,90,180,270} 由端口边集合匹配唯一解出。 */
  | "solver"
  /** 求解不唯一或失败，回退恒等并警告。 */
  | "fallback-identity";

export interface RotationResolution {
  readonly entityId: string;
  readonly definitionId: string;
  readonly officialRot: number;
  readonly chosenRot: number;
  readonly source: RotationResolutionSource;
}

export interface ConvertReport {
  readonly entityCount: number;
  readonly deviceCount: number;
  readonly logisticsCount: number;
  readonly slotLinkCount: number;
  /** 注册表不支持的节点（templateId + 原因），转换不中断。 */
  readonly skipped: readonly { readonly templateId: string; readonly reason: string }[];
  /** 端口接驳冲突等需要人工知晓的警告（不静默）。 */
  readonly warnings: readonly string[];
  /** 转换说明（配置写入、配方匹配等）。 */
  readonly notes: readonly string[];
  readonly rotationResolutions: readonly RotationResolution[];
  readonly topologyCheck: {
    readonly connectionCount: number;
    readonly unconnectedPortWarnings: readonly string[];
    /** 连接对明细（"sourcePortId->targetPortId"），报告 UI 与回归 diff 用。 */
    readonly connectionPairs: readonly string[];
    /** 完整显式边（文档级端口标识 + 格坐标），边表 sidecar 的生成源。 */
    readonly connections: readonly ExplicitEdge[];
    /** 参与连通判定的端口全集（manual 边可解析性校验用）。 */
    readonly ports: readonly EdgeSourcePort[];
  };
  /**
   * 单格物流段声明方向的下游连通审计（F2）。
   * 忠实采用官方声明 (directionIn/Out) 后，声明出向无对接（断头）的格子列表——
   * 供用户知悉"该格在原蓝图中可能为断头/装饰带或平台无法表达的宽容结构"，不改写声明。
   */
  readonly directionDivergences: readonly string[];
  /** 蓝图含 hongs_bus 时提示可选 valley4 基地。 */
  readonly baseIdSuggestion?: string;
}

export interface ConvertResult {
  readonly doc: BlueprintDocument;
  readonly report: ConvertReport;
}

/** 平台网格角（0|90|180|270，顺时针为正）。 */
export type QuarterRotation = 0 | 90 | 180 | 270;
