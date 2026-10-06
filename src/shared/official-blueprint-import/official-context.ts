import type { WorldEntity } from "@/domain/document/world-document";
import type { SlotLinkDefinition } from "@/domain/shared/slot-link";
import type { RegistryContract } from "@/domain/registry/registry-contract";
import type {
  ConvertOptions,
  QuarterRotation,
} from "./official-types";

/** 物流族。 */
export type LogisticsKind = "belt" | "pipe";

/** 设备元数据（端口几何用物理帧 = 官方 rot）。 */
export interface DeviceMeta {
  readonly definitionId: string;
  readonly x: number;
  readonly y: number;
  readonly rotOfficial: QuarterRotation;
  /** 旋转后占地尺寸。 */
  readonly w: number;
  readonly h: number;
  /** 官方模板 ID（诊断用）。 */
  readonly templateId: string;
}

export interface LogisticsMeta {
  readonly kind: LogisticsKind;
  readonly x: number;
  readonly y: number;
}

/** 转换器共享上下文（对应 Python Converter 实例字段）。 */
export interface ConverterContext {
  readonly registry: RegistryContract;
  readonly options: Required<Pick<ConvertOptions, "baseId" | "infiniteSupply">> & ConvertOptions;
  /** zSize - 1（Z 镜像基准）。 */
  readonly zMax: number;
  readonly entities: Record<string, WorldEntity>;
  readonly order: string[];
  readonly slotLinks: SlotLinkDefinition[];
  readonly skipped: { templateId: string; reason: string }[];
  readonly warnings: string[];
  readonly notes: string[];
  readonly devMeta: Map<string, DeviceMeta>;
  readonly logiMeta: Map<string, LogisticsMeta>;
  /** 物流占用索引：key = `${kind}:${x}:${y}`（带×管同格叠放 key 不同）。 */
  readonly cellOwner: Map<string, string>;
  readonly counters: Map<string, number>;
}

export function createConverterContext(
  registry: RegistryContract,
  zSize: number,
  options: ConvertOptions,
): ConverterContext {
  return {
    registry,
    options: {
      baseId: options.baseId ?? "wuling_protocol_core",
      infiniteSupply: options.infiniteSupply ?? true,
      ...options,
    },
    zMax: zSize - 1,
    entities: {},
    order: [],
    slotLinks: [],
    skipped: [],
    warnings: [],
    notes: [],
    devMeta: new Map(),
    logiMeta: new Map(),
    cellOwner: new Map(),
    counters: new Map(),
  };
}

export function cellOwnerKey(kind: LogisticsKind, x: number, y: number): string {
  return `${kind}:${x}:${y}`;
}

/** 分配实体 ID：设备 `${defId}:${n}`（每定义递增），物流节由调用方按格坐标给出。 */
export function allocateEntityId(ctx: ConverterContext, definitionId: string): string {
  const index = ctx.counters.get(definitionId) ?? 0;
  ctx.counters.set(definitionId, index + 1);
  return `${definitionId}:${index}`;
}
