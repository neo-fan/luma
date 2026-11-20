import { useState } from "react";
import { cleanConfigName, configNameFromUrl } from "../../lib/config";
import { api, errorMessage } from "../../lib/invoke";
import { log } from "../../lib/logger";
import type { ConfigSnapshot } from "../../types/luma";

interface ConfigImportSectionProps {
  onImported: (snapshot: ConfigSnapshot) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onReload: () => void;
}

/** 导入配置：URL 与粘贴文本两条入口，共用「配置名称」预览（默认取域名，可改）。 */
export default function ConfigImportSection({
  onImported,
  onNotice,
  onError,
  onReload,
}: ConfigImportSectionProps) {
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  /** 导入时使用的配置名；默认取 URL 域名，用户可以直接改。 */
  const [name, setName] = useState("");
  /** 用户手动改过名字后，就不再跟着 URL 自动变。 */
  const [nameTouched, setNameTouched] = useState(false);
  const [importing, setImporting] = useState(false);

  const importConfig = async (kind: "url" | "text", value: string) => {
    if (!value) {
      onError(kind === "url" ? "请先填写订阅地址" : "请先粘贴订阅内容");
      return;
    }
    setImporting(true);
    onError("");
    onNotice("");
    try {
      const snapshot = await api.configImport({
        kind,
        value,
        // 只有用户真的改过名字才提交。输入框里自动填的域名只是「默认值预览」，
        // 跟着发过去会把同一份配置已有的自定义名改掉（`box` 会变回域名）。
        // 没提交时后端按「保留已有名字 → 域名」的顺序兜底。
        name: nameTouched ? cleanConfigName(name) || undefined : undefined,
      });
      onImported(snapshot);
      // configImport 返回的是运行配置（导入原件在后端单独保留）；把主动
      // 屏蔽的数量和原因报出来，用户才知道为什么站点比原始 json 里少。
      // 原因不止 jar 一种（还有「相对地址只能从 URL 导入」），所以不再写死文案，
      // 直接把后端给的原因去重后展示。
      const usable = snapshot.sites.filter((site) => site.enabled).length;
      const blocked = snapshot.sites.filter((site) => site.disabledReason).length;
      const reasons = [
        ...new Set(
          snapshot.sites
            .map((site) => site.disabledReason)
            .filter((reason): reason is string => Boolean(reason)),
        ),
      ];
      onNotice(
        `已导入「${snapshot.name}」，${usable} 个可用站点` +
          (blocked > 0
            ? `；已屏蔽 ${blocked} 个站点（${reasons.join("；")}）`
            : ""),
      );
      log.info("config imported", {
        id: snapshot.id,
        name: snapshot.name,
        kind,
        sites: snapshot.sites.length,
        enabled: usable,
        blocked,
      });
      if (kind === "url") {
        setUrl("");
      } else {
        setText("");
      }
      // 名字只对本次导入有效：清空后下次会重新按域名推导。
      setName("");
      setNameTouched(false);
      onReload();
    } catch (err) {
      onError(`导入失败：${errorMessage(err)}`);
      log.error("config import failed", { kind, message: errorMessage(err) });
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <div className="settings-block">
        <h2 className="section-title">导入订阅（URL）</h2>
        <div className="search-bar">
          <input
            className="input"
            type="text"
            value={url}
            placeholder="https://example.com/api.json"
            onChange={(event) => {
              const next = event.target.value;
              setUrl(next);
              // 只在用户没手动改过名字时跟着 URL 走，避免覆盖自定义名。
              if (!nameTouched) {
                setName(configNameFromUrl(next));
              }
            }}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={importing}
            onClick={() => void importConfig("url", url.trim())}
          >
            {importing ? "导入中…" : "导入"}
          </button>
        </div>
        <label className="config-name">
          <span className="config-name__label">订阅名称</span>
          <input
            className="input"
            type="text"
            value={name}
            maxLength={48}
            placeholder="留空则使用域名 / 订阅内名称"
            onChange={(event) => {
              setName(event.target.value);
              setNameTouched(true);
            }}
          />
          <small className="config-name__hint">
            URL 与粘贴文本共用；默认取域名，可改成任意名字，保存后可在下方切换
          </small>
        </label>
      </div>

      <div className="settings-block">
        <h2 className="section-title">导入订阅（粘贴文本）</h2>
        <textarea
          className="textarea"
          value={text}
          placeholder="把 api.json 的内容粘贴到这里（名称沿用上方「订阅名称」）"
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={importing}
          onClick={() => void importConfig("text", text.trim())}
        >
          {importing ? "导入中…" : "导入文本"}
        </button>
      </div>
    </>
  );
}
