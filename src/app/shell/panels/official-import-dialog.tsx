import { observer } from "mobx-react-lite";
import { useCallback, useMemo, useState } from "react";

import { createImportedBlueprintDocument } from "@/app/blueprint/blueprint-transfer";
import type { AppHost } from "@/app/host/app-host";
import { DialogShell } from "@/app/shell/shared/dialog-shell";
import { cm } from "@/app/shell/shared/css-module-class";
import styles from "@/app/shell/app-shell.module.scss";
import type { DialogStateReadWrite } from "@/app/state/state-impl";
import { createRegistryContract } from "@/registry";
import { createEntropyClient } from "@/shared/endfield/entropy-api";
import {
  readCachedBlueprint,
  writeCachedBlueprint,
} from "@/shared/endfield/entropy-cache";
import { parseBlueprintCodeInput } from "@/shared/endfield/blueprint-code";
import {
  convertOfficialBlueprint,
  extractOfficialBlueprintData,
} from "@/shared/official-blueprint-import";
import type {
  ConvertReport,
  OfficialBlueprintData,
} from "@/shared/official-blueprint-import";
import type { BlueprintDocument } from "@/domain/document/blueprint-document";

/**
 * "从蓝图码导入"对话框（自包含）。
 * 输入官方蓝图码（多码支持）→ 熵增 API 解析（IndexedDB 级 localStorage 缓存）
 * → 内嵌导入器转换 → ConvertReport 报告 → 逐份确认入库。
 * 降级路径：直接粘贴官方蓝图 JSON（API 不可用时）。
 */

interface ResolvedEntry {
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly doc?: BlueprintDocument;
  readonly report?: ConvertReport;
  readonly error?: string;
}

interface OfficialImportDialogProps {
  readonly appHost: AppHost;
  readonly visible: boolean;
  readonly targetFolderId: string | null;
  readonly onClose: () => void;
  /** 入库完成回调（面板刷新列表 + 切到 user tab）。 */
  readonly onImported: () => void;
}

/** 蓝图码校验失败原因展示（i18n）。 */
function codeFailureMessage(
  t: (key: string) => string,
  fragment: string,
  reason: string,
): string {
  return t(`workbench.blueprint.officialImport.codeFailure.${reason}`)
    .replace("{fragment}", fragment);
}

function summarizeReport(
  t: (key: string) => string,
  report: ConvertReport,
): string {
  return t("workbench.blueprint.officialImport.summary")
    .replace("{entities}", String(report.entityCount))
    .replace("{devices}", String(report.deviceCount))
    .replace("{logistics}", String(report.logisticsCount))
    .replace("{connections}", String(report.topologyCheck.connectionCount))
    .replace("{slotLinks}", String(report.slotLinkCount));
}

export const OfficialImportDialog = observer(function OfficialImportDialog({
  appHost,
  visible,
  targetFolderId,
  onClose,
  onImported,
}: OfficialImportDialogProps) {
  const t = appHost.actions.translate;
  const [inputText, setInputText] = useState("");
  const [isParsing, setIsParsing] = useState(false);
  const [entries, setEntries] = useState<ResolvedEntry[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const entropyClient = useMemo(() => createEntropyClient(), []);

  // 本地构造 DialogShell 所需的对话框状态（不自接入全局 workbench dialogState，
  // 保持对面板的最小侵入；对话框不支持拖拽调整尺寸）。
  const dialogState: DialogStateReadWrite = {
    visible,
    maximized: false,
    offsetX: 0,
    offsetY: 0,
    width: null,
    height: null,
    activeTab: null,
  };

  const handleParse = useCallback(async () => {
    const text = inputText.trim();
    if (text.length === 0) {
      setFormError(t("workbench.blueprint.officialImport.empty"));
      return;
    }
    setIsParsing(true);
    setFormError(null);
    const registry = createRegistryContract();

    // 降级路径：输入是官方蓝图 JSON（API 不可用时直接粘贴）
    if (text.startsWith("{")) {
      try {
        const data: OfficialBlueprintData = extractOfficialBlueprintData(JSON.parse(text));
        const { doc, report } = convertOfficialBlueprint(data, { registry });
        setEntries([{
          key: "pasted-json",
          code: "pasted-json",
          name: data.name ?? "未命名蓝图",
          doc,
          report,
        }]);
      } catch (error) {
        setEntries([{
          key: "pasted-json",
          code: "pasted-json",
          name: "",
          error: error instanceof Error ? error.message : String(error),
        }]);
      } finally {
        setIsParsing(false);
      }
      return;
    }

    const parsed = parseBlueprintCodeInput(text);
    const codes = parsed.codes;
    // 校验失败片段逐条展示（不发起 API 请求）
    const failureEntries: ResolvedEntry[] = parsed.failures.map((failure) => ({
      key: `invalid-${failure.fragment}`,
      code: failure.fragment,
      name: failure.fragment,
      error: codeFailureMessage(t, failure.fragment, failure.reason),
    }));
    if (codes.length === 0) {
      if (failureEntries.length > 0) {
        setEntries(failureEntries);
      } else {
        setFormError(t("workbench.blueprint.officialImport.empty"));
      }
      setIsParsing(false);
      return;
    }

    const resolved: ResolvedEntry[] = [];
    for (const code of codes) {
      try {
        let data = readCachedBlueprint(code);
        if (data === null) {
          data = await entropyClient.fetchBlueprintByCode(code);
          writeCachedBlueprint(code, data);
        }
        const { doc, report } = convertOfficialBlueprint(data, {
          registry,
          blueprintCode: code, // 内嵌边表溯源（缓存仅含 bluePrintData，sourceHash 不可得）
        });
        resolved.push({
          key: code,
          code,
          name: data.name ?? code,
          doc,
          report,
        });
      } catch (error) {
        resolved.push({
          key: code,
          code,
          name: code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    setEntries([...resolved, ...failureEntries]);
    setIsParsing(false);
  }, [entropyClient, inputText, t]);

  const handleImportEntry = useCallback((entry: ResolvedEntry) => {
    if (entry.doc === undefined) return;
    appHost.saveBlueprintDialog.openImported(
      createImportedBlueprintDocument(entry.doc),
      targetFolderId,
    );
    onImported();
  }, [appHost, onImported, targetFolderId]);

  if (!visible) {
    return null;
  }

  return (
    <DialogShell
      bodyClassName="save-blueprint-dialog-body"
      className="official-import-dialog"
      closeTitle={t("action.close")}
      compactMobileLayout={appHost.state.screenProfile.deviceClass === "mobile"}
      dialogKey="official-import"
      dialogState={dialogState}
      immersiveMaximized={false}
      maximizeTitle={t("dialog.maximize")}
      onClose={onClose}
      onOffsetChange={() => {}}
      restoreTitle={t("dialog.restore")}
      shellStyle={{ width: "520px", minHeight: "320px" }}
      showMaximizeButton={false}
      title={t("workbench.blueprint.officialImport.title")}
      titleId="official-import-dialog-title"
    >
      <div className={cm(styles, "save-blueprint-dialog-content")}>
        <div className={cm(styles, "save-blueprint-form")}>
          <div className={cm(styles, "save-blueprint-form-content")}>
            <label className={cm(styles, "save-blueprint-field")}>
              <span className={cm(styles, "save-blueprint-label")}>
                {t("workbench.blueprint.officialImport.inputLabel")}
              </span>
              <textarea
                autoFocus
                className={cm(styles, "save-blueprint-input")}
                data-official-import-input
                disabled={isParsing}
                onChange={(event) => {
                  setInputText(event.currentTarget.value);
                  if (formError !== null) setFormError(null);
                }}
                placeholder={t("workbench.blueprint.officialImport.inputPlaceholder")}
                rows={4}
                value={inputText}
              />
            </label>
            {formError === null ? null : (
              <p className={cm(styles, "save-blueprint-error")} role="alert">{formError}</p>
            )}
          </div>
          <div className={cm(styles, "save-blueprint-actions")}>
            <button
              className={cm(styles, "save-blueprint-secondary-button")}
              data-ui-button-id="official-import-close"
              disabled={isParsing}
              onClick={onClose}
              type="button"
            >
              {t("workbench.blueprint.officialImport.close")}
            </button>
            <button
              className={cm(styles, "save-blueprint-primary-button")}
              data-ui-button-id="official-import-parse"
              disabled={isParsing}
              onClick={() => {
                void handleParse();
              }}
              type="button"
            >
              {isParsing
                ? t("workbench.blueprint.officialImport.parsing")
                : t("workbench.blueprint.officialImport.parse")}
            </button>
          </div>
        </div>

        {entries.length > 0 ? (
          <div className={cm(styles, "save-blueprint-form-content")} data-official-import-results>
            {entries.map((entry) => (
              <div key={entry.key} className={cm(styles, "save-blueprint-field")}>
                <span className={cm(styles, "save-blueprint-label")}>
                  {entry.name}
                </span>
                {entry.error !== undefined ? (
                  <p className={cm(styles, "save-blueprint-error")} role="alert">
                    {entry.code}: {entry.error}
                  </p>
                ) : (
                  <>
                    <p>{entry.report !== undefined ? summarizeReport(t, entry.report) : ""}</p>
                    {entry.report !== undefined && entry.report.skipped.length > 0 ? (
                      <p className={cm(styles, "save-blueprint-error")} role="alert">
                        {t("workbench.blueprint.officialImport.skipped")
                          .replace("{count}", String(entry.report.skipped.length))}
                        {"："}{entry.report.skipped.map((s) => s.templateId).join(", ")}
                      </p>
                    ) : null}
                    {entry.report !== undefined && entry.report.warnings.length > 0 ? (
                      <p>
                        {t("workbench.blueprint.officialImport.warnings")
                          .replace("{count}", String(entry.report.warnings.length))}
                      </p>
                    ) : null}
                    {entry.report !== undefined
                      && entry.report.rotationResolutions.some(
                        (r) => r.source === "solver" || r.source === "fallback-identity",
                      ) ? (
                        <p className={cm(styles, "save-blueprint-error")} role="alert">
                          {t("workbench.blueprint.officialImport.rotationWarnings").replace(
                            "{count}",
                            String(entry.report.rotationResolutions.filter(
                              (r) => r.source === "solver" || r.source === "fallback-identity",
                            ).length),
                          )}
                        </p>
                      ) : null}
                    {entry.report?.baseIdSuggestion !== undefined ? (
                      <p>{entry.report.baseIdSuggestion}</p>
                    ) : null}
                    <div className={cm(styles, "save-blueprint-actions")}>
                      <button
                        className={cm(styles, "save-blueprint-primary-button")}
                        data-ui-button-id={`official-import-import-${entry.code}`}
                        onClick={() => {
                          handleImportEntry(entry);
                        }}
                        type="button"
                      >
                        {t("workbench.blueprint.officialImport.import")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </DialogShell>
  );
});
