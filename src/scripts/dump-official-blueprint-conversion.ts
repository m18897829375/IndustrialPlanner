/**
 * 官方蓝图 JSON → 平台 BlueprintDocument（schema 6）命令行转换器。
 *
 * 用法：
 *   npx tsx --tsconfig tsconfig.app.json src/scripts/dump-official-blueprint-conversion.ts <input.json> <output.json> [--edges <edges.json>]
 *   npx tsx --tsconfig tsconfig.app.json src/scripts/dump-official-blueprint-conversion.ts --check-edges <input.json> <edges.json>
 *
 * 输入：官方蓝图解析 JSON（熵增 API 完整响应或裸 bluePrintData）。
 * 用途：P4 与 Python 原型的回归对比；无浏览器环境下的批量转换。
 *
 * --edges：把导入推断出的物理连接冻结为显式边表 sidecar（可审查、可手工修正）。
 * --check-edges：重新转换并与已有边表 diff（对称差报告；manual 边只校验端口
 *   可解析性，不报"几何不一致"）；有差异时退出码 1。
 * --merge-edges <sidecar.json>：转换时合并人工修正边表（disabled 禁边 +
 *   manual 追加），合并结果内嵌进输出文档的 logisticsEdges，仿真编译时边表
 *   在场即权威（缺边=不连）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { createRegistryContract } from "@/registry";
import {
  buildExplicitEdgeTable,
  convertOfficialBlueprint,
  diffEdgeTables,
  extractOfficialBlueprintData,
  parseEdgeTable,
  validateEdgeEndpoints,
  type ConvertResult,
  type ExplicitEdge,
  type ExplicitEdgeTable,
  type OfficialBlueprintData,
} from "@/shared/official-blueprint-import";

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** 从原始响应取蓝图码（信封 data.data.query.code），缺失时回退文件名。 */
function blueprintCodeOf(raw: unknown, inputPath: string): string {
  const code = (raw as { data?: { data?: { query?: { code?: unknown } } } })
    ?.data?.data?.query?.code;
  if (typeof code === "string" && code.length > 0) return code;
  const match = /bp_([^.]+)\.json$/.exec(inputPath);
  return match?.[1] ?? "unknown";
}

function formatEdge(edge: ExplicitEdge): string {
  const fmt = (e: ExplicitEdge["from"]): string =>
    `${e.entityId} ${e.port.group}.${e.port.id}.${e.port.direction}@(${e.cell.x},${e.cell.y})→(${e.outside.x},${e.outside.y})`;
  return `${edge.id} [${edge.kind}] ${fmt(edge.from)}  →  ${fmt(edge.to)}`;
}

interface Conversion {
  readonly raw: unknown;
  readonly rawText: string;
  readonly data: OfficialBlueprintData;
  readonly doc: ConvertResult["doc"];
  readonly report: ConvertResult["report"];
}

function convert(inputPath: string, sidecarPath?: string): Conversion {
  const rawText = readFileSync(inputPath, "utf8");
  const raw = JSON.parse(rawText) as unknown;
  const data = extractOfficialBlueprintData(raw);
  const edgeSidecar = sidecarPath !== undefined
    ? parseEdgeTable(JSON.parse(readFileSync(sidecarPath, "utf8")))
    : undefined;
  const { doc, report } = convertOfficialBlueprint(data, {
    registry: createRegistryContract(),
    blueprintCode: blueprintCodeOf(raw, inputPath),
    blueprintSourceHash: sha256(rawText),
    ...(edgeSidecar !== undefined ? { edgeSidecar } : {}),
  });
  return { raw, rawText, data, doc, report };
}

function buildTable(inputPath: string, converted: Conversion): ExplicitEdgeTable {
  return buildExplicitEdgeTable({
    edges: converted.report.topologyCheck.connections,
    blueprintCode: blueprintCodeOf(converted.raw, inputPath),
    sourceHash: sha256(converted.rawText),
    zMax: converted.data.zSize - 1,
  });
}

function checkEdges(inputPath: string, edgesPath: string): number {
  if (!existsSync(edgesPath)) {
    console.error(`✗ 边表不存在: ${edgesPath}`);
    return 1;
  }
  const converted = convert(inputPath);
  const fresh = buildTable(inputPath, converted);
  const sidecar = parseEdgeTable(JSON.parse(readFileSync(edgesPath, "utf8")));

  if (sidecar.sourceHash !== fresh.sourceHash) {
    console.warn(
      `⚠️ sourceHash 不一致：边表可能过期`
      + `（sidecar=${sidecar.sourceHash.slice(0, 26)}… fresh=${fresh.sourceHash.slice(0, 26)}…）`,
    );
  }

  const diff = diffEdgeTables(fresh, sidecar);
  let problems = 0;

  for (const edge of diff.onlyInFresh) {
    console.log(`+ 仅新推断: ${formatEdge(edge)}`);
    problems++;
  }
  for (const edge of diff.onlyInSidecar) {
    console.log(`- 仅边表(inferred): ${formatEdge(edge)}`);
    problems++;
  }
  for (const id of diff.disabled) {
    console.log(`⊘ 人工禁用: ${id}`);
  }
  for (const edge of diff.manual) {
    console.log(`✎ 人工边: ${formatEdge(edge)}`);
  }

  // manual 边只校验端口可解析性（不参与几何一致性比对）
  for (const issue of validateEdgeEndpoints(diff.manual, converted.report.topologyCheck.ports)) {
    console.log(`✗ 人工边端口不可解析: ${issue.edgeId} ${issue.endpoint} — ${issue.reason}`);
    problems++;
  }

  if (problems === 0) {
    console.log(
      `✓ 边表一致（${fresh.edges.length} 条边，人工边 ${diff.manual.length} 条，禁用 ${diff.disabled.length} 条）`,
    );
    return 0;
  }
  console.log(`✗ 边表 diff: ${problems} 处差异`);
  return 1;
}

function main(): void {
  const args = process.argv.slice(2);

  const checkIdx = args.indexOf("--check-edges");
  if (checkIdx >= 0) {
    const positional = args.filter((_, i) => i !== checkIdx);
    const [inputPath, edgesPath] = positional;
    if (inputPath === undefined || edgesPath === undefined) {
      console.error("用法: tsx dump-official-blueprint-conversion.ts --check-edges <input.json> <edges.json>");
      process.exit(1);
    }
    process.exit(checkEdges(inputPath, edgesPath));
  }

  const edgesIdx = args.indexOf("--edges");
  const mergeIdx = args.indexOf("--merge-edges");
  const skip = new Set<number>();
  if (edgesIdx >= 0) { skip.add(edgesIdx); skip.add(edgesIdx + 1); }
  if (mergeIdx >= 0) { skip.add(mergeIdx); skip.add(mergeIdx + 1); }
  const positional = args.filter((_, i) => !skip.has(i));
  const [inputPath, outputPath] = positional;
  const edgesPath = edgesIdx >= 0 ? args[edgesIdx + 1] : undefined;
  const mergePath = mergeIdx >= 0 ? args[mergeIdx + 1] : undefined;
  if (
    inputPath === undefined || outputPath === undefined
    || (edgesIdx >= 0 && edgesPath === undefined)
    || (mergeIdx >= 0 && mergePath === undefined)
  ) {
    console.error("用法: tsx dump-official-blueprint-conversion.ts <input.json> <output.json> [--edges <edges.json>] [--merge-edges <sidecar.json>]");
    process.exit(1);
  }

  const converted = convert(inputPath, mergePath);
  writeFileSync(outputPath, `${JSON.stringify(converted.doc, null, 2)}\n`, "utf8");

  if (mergePath !== undefined) {
    console.log(`  已合并人工边表: ${mergePath}（内嵌 logisticsEdges=${converted.doc.logisticsEdges?.edges.length ?? 0} 条边）`);
  }

  if (edgesPath !== undefined) {
    const table = buildTable(inputPath, converted);
    writeFileSync(edgesPath, `${JSON.stringify(table, null, 2)}\n`, "utf8");
    console.log(`  边表已写出: ${edgesPath}（${table.edges.length} 条边）`);
  }

  const report = converted.report;
  console.log(
    `${inputPath}: 实体 ${report.entityCount}（设备 ${report.deviceCount} / 物流 ${report.logisticsCount}）`
    + ` 连接 ${report.topologyCheck.connectionCount} slotLinks ${report.slotLinkCount}`
    + ` 跳过 ${report.skipped.length} 警告 ${report.warnings.length}`,
  );
}

main();
