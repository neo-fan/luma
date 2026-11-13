import { useState } from "react";
import { DEFAULT_EPG_URL, getEpgUrl, setEpgUrl } from "../../lib/epgSettings";

/** 电子节目单（EPG）地址导入：支持填写任意 XMLTV 节目单地址，默认预填 GitHub 仓库。 */
export default function EpgsSection() {
  const [value, setValue] = useState(() => getEpgUrl());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const persist = (url: string, okMessage: string) => {
    setError("");
    const trimmed = url.trim();
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      setError("请输入以 http(s):// 开头的节目单地址");
      return;
    }
    setEpgUrl(trimmed);
    setValue(trimmed || DEFAULT_EPG_URL);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
    void okMessage;
  };

  const isDefault = (value.trim() || DEFAULT_EPG_URL) === DEFAULT_EPG_URL;

  return (
    <div className="settings-block">
      <h2 className="section-title">电子节目单（EPG）</h2>
      <p className="settings-line">
        导入一个 XMLTV 节目单地址，直播时将按频道名匹配并显示当前节目。默认使用 GitHub
        上的公开仓库，可替换为任意节目单地址。
      </p>
      <div className="epg-row">
        <input
          className="text-input"
          type="text"
          placeholder={DEFAULT_EPG_URL}
          value={value}
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="button" className="btn btn--sm" onClick={() => persist(value, "已保存")}>
          保存
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => persist(DEFAULT_EPG_URL, "已恢复默认")}
        >
          恢复默认
        </button>
      </div>
      {error ? <p className="tip tip--err">{error}</p> : null}
      {saved ? <p className="tip tip--ok">已保存</p> : null}
      {isDefault ? <p className="settings-line">当前为默认节目单地址。</p> : null}
    </div>
  );
}
