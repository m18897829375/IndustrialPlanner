import type { GridPoint } from "../shared/grid";

/**
 * 显式物流边表（Explicit Edge Table）——文档级类型定义。
 *
 * 背景：终末地蓝图协议（CSD_BLUE_PRINT_NODE/TRANSFORM）不含连接字段，
 * 游戏保存蓝图时丢弃运行时连接边，拍蓝图时按几何重建。平台导入器同样
 * 几何推断连接；本类型把推断结果冻结为可 diff、可审查、可人工覆盖的
 * 显式工件。
 *
 * 端点用文档级稳定标识（entityId + portGroup/port + direction），绝不落盘
 * 编译期端口 ID（`device:.../port:...` 为运行时产物）。cell/outside 格坐标
 * 供人审阅与手工修正（改坐标即可，不必懂端口组命名）。
 *
 * 类型放在 domain/document 层：BlueprintDocument/WorldDocument 直接引用，
 * 避免 domain 反向依赖 shared/official-blueprint-import 的构建逻辑。
 */

export const EDGE_TABLE_FORMAT = "bphub/blueprint-edges@1" as const;

export type EdgePortDirection = "input" | "output";

/** 文档级端口引用。 */
export interface EdgeEndpointRef {
  readonly entityId: string;
  readonly port: {
    readonly group: string;
    readonly id: string;
    readonly direction: EdgePortDirection;
  };
  /** 端口内侧格（设备/物流节占地格）。 */
  readonly cell: GridPoint;
  /** 端口外侧格（对接格）。 */
  readonly outside: GridPoint;
}

export interface ExplicitEdge {
  readonly id: string;
  readonly kind: "belt" | "pipe";
  /** 物流流向：from = output 侧端口，to = input 侧端口。 */
  readonly from: EdgeEndpointRef;
  readonly to: EdgeEndpointRef;
  /** inferred = 几何推断产物；manual = 人工修正（diff 时不参与几何一致性比对）。 */
  readonly provenance: "inferred" | "manual";
}

export interface ExplicitEdgeTable {
  readonly format: typeof EDGE_TABLE_FORMAT;
  /** 源蓝图码（仅供参考；导入器内嵌时可为空串）。 */
  readonly blueprintCode: string;
  /** 源蓝图原文 sha256（检测边表与源蓝图失配；内嵌时可为空串）。 */
  readonly sourceHash: string;
  readonly grid: { readonly zMax: number };
  readonly edges: readonly ExplicitEdge[];
  /** 人工禁用的推断边 id（保留审查痕迹，不做物理删除）。 */
  readonly disabled: readonly string[];
}
