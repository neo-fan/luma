#!/usr/bin/env python3
"""Scan a TVBox config (or multi-repo config) for CMS sources that still play.

Usage:
    python3 tools/audit/scan_sources.py <config-url> [<config-url> ...]
    python3 tools/audit/scan_sources.py --keyword 走马上任 <config-url>

For every CMS site it runs search -> detail -> first episode, then checks the
stream URL over HTTP. Reports one line per source so dead CDNs are obvious.

Nothing is written to the repository; this is a developer/verification tool.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

# 这三份都是「开发工具副本」：应用运行时的配置解密 / 方言归一化 / CMS 解析
# 全在 Rust（`src-tauri/src/domain/{config,spider}/`），sidecar 里不再有它们。
# 审计脚本只在自己进程里跑，所以就地放在本目录。
sys.path.insert(0, str(Path(__file__).resolve().parent))

import cms  # noqa: E402
from decrypt import DecryptError, decrypt  # noqa: E402
from normalize import merge_repos, normalize_config  # noqa: E402
from urllib.parse import quote  # noqa: E402

UA = "okhttp/3.15"


def fetch(url: str, timeout: int = 20, ua: str = UA) -> str:
    result = subprocess.run(
        ["curl", "-sSL", "-m", str(timeout), "-A", ua, url],
        capture_output=True,
    )
    return result.stdout.decode("utf-8", "replace")


def head_status(url: str, timeout: int = 12) -> int:
    result = subprocess.run(
        ["curl", "-sSL", "-m", str(timeout), "-A", "Mozilla/5.0 Chrome/120",
         "-o", "/dev/null", "-w", "%{http_code}", url],
        capture_output=True,
        text=True,
    )
    try:
        return int(result.stdout.strip() or 0)
    except ValueError:
        return 0


def load_config(url: str, depth: int = 0) -> dict | None:
    raw = fetch(url)
    if not raw.strip():
        print(f"  ! empty response: {url}")
        return None
    try:
        plain, how = decrypt(raw)
    except DecryptError as err:
        print(f"  ! not decryptable: {url} ({err})")
        return None
    try:
        cfg = json.loads(plain)
    except json.JSONDecodeError:
        print(f"  ! not json: {url}")
        return None
    print(f"  · {how}: {len(cfg.get('sites') or [])} sites, {len(cfg.get('urls') or [])} repos")

    if cfg.get("urls") and depth < 2:
        snapshots = []
        for item in cfg["urls"][:10]:
            repo = item if isinstance(item, str) else item.get("url", "")
            if not repo:
                continue
            print(f"    repo: {repo[:90]}")
            sub = load_config(repo, depth + 1)
            if sub:
                snapshots.append(sub)
        if snapshots:
            merged = {"sites": [], "lives": [], "parses": []}
            for sub in snapshots:
                merged["sites"].extend(sub.get("sites") or [])
                merged["lives"].extend(sub.get("lives") or [])
                merged["parses"].extend(sub.get("parses") or [])
            return merged
    return cfg if cfg.get("sites") else None


def scan(config_url: str, keyword: str) -> list[str]:
    print(f"== {config_url}")
    raw_cfg = load_config(config_url)
    if not raw_cfg:
        return []
    try:
        cfg = normalize_config(raw_cfg, config_url)
    except Exception as err:  # noqa: BLE001
        print(f"  ! normalize failed: {err}")
        return []
    sites = [s for s in cfg.get("sites") or [] if s.get("runtime") == "cms"]
    print(f"  cms sites: {len(sites)}")
    hits: list[str] = []
    for site in sites:
        api = str(site.get("api") or "")
        sep = "/?" if (api and not api.endswith("/") and "." not in api.rsplit("/", 1)[-1]) else ("&" if "?" in api else "?")
        search_url = f"{api}{sep}ac=videolist&wd={quote(keyword)}&pg=1"
        body = fetch(search_url, timeout=15)
        try:
            page = cms.parse_page(body) if body.strip() else {"list": []}
        except Exception:  # noqa: BLE001
            print(f"    {site.get('key')}: search parse failed")
            continue
        items = page.get("list") or []
        if not items:
            print(f"    {site.get('key')}: 0 results")
            continue
        item = items[0]
        detail_url = f"{api}{sep}ac=detail&ids={item.get('vod_id')}"
        detail_body = fetch(detail_url, timeout=15)
        try:
            detail = cms.parse_detail({"raw": detail_body})
        except Exception:  # noqa: BLE001
            print(f"    {site.get('key')}: detail parse failed")
            continue
        if not detail:
            print(f"    {site.get('key')}: empty detail")
            continue
        play = str(detail[0].get("vod_play_url") or "")
        episode = play.split("$$$")[0].split("#")[0]
        stream = episode.split("$", 1)[1] if "$" in episode else episode
        if not stream.startswith("http"):
            print(f"    {site.get('key')}: no stream ({stream[:40]})")
            continue
        if ".m3u8" not in stream and ".mp4" not in stream:
            print(f"    {site.get('key')}: needs parse page -> {stream[:60]}")
            continue
        status = head_status(stream)
        mark = "HIT " if status == 200 else "    "
        print(f"    {mark}{site.get('key')}: {status} {stream[:80]}")
        if status == 200:
            hits.append(f"{site.get('key')} | {item.get('vod_name')} | {stream}")
    return hits


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("configs", nargs="+")
    parser.add_argument("--keyword", default="走马上任")
    args = parser.parse_args()

    all_hits: list[str] = []
    for url in args.configs:
        try:
            all_hits.extend(scan(url, args.keyword))
        except Exception as err:  # noqa: BLE001
            print(f"  ! scan failed: {err}")

    print("\n=== playable ===")
    for hit in all_hits:
        print(hit)
    print(f"total: {len(all_hits)}")
    return 0 if all_hits else 1


if __name__ == "__main__":
    raise SystemExit(main())
