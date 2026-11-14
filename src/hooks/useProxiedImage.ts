import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/invoke";
import { buildImageUrl, needsProxy } from "../lib/imageUrl";

/**
 * Shared, once-per-app lookup of the local proxy base URL. 200+ cards on an
 * aggregate search must NOT each fire `proxy_status`; the first one starts the
 * request and everyone awaits the same promise. On failure we clear the cache
 * so the next card can retry, and consumers fall back to the raw pic.
 */
const PROXY_BASE_TIMEOUT_MS = 2500;
let proxyBasePromise: Promise<string | null> | null = null;

/**
 * 已经算好的代理地址（`vod_pic` → `/image?url=…`）。
 *
 * 代理端口在进程内固定，同一个 `vod_pic` 每次都能拼出同一个地址；而换集
 * 会重挂载播放页，信息卡的海报要等 `proxy_status` 回来才拿到 `src`，中间
 * 那一帧就是「无封面」——用户看到海报闪一下。记住结果后首帧直接有值，
 * React 会照常渲染 `<img>`，浏览器命中已解码的图，不再闪。
 */
const RESOLVED_SRC = new Map<string, string>();
const MAX_RESOLVED_SRC = 400;

function rememberResolved(pic: string, src: string): void {
  if (RESOLVED_SRC.size >= MAX_RESOLVED_SRC) {
    const oldest = RESOLVED_SRC.keys().next().value;
    if (oldest !== undefined) {
      RESOLVED_SRC.delete(oldest);
    }
  }
  RESOLVED_SRC.set(pic, src);
}

export function getProxyBaseUrl(): Promise<string | null> {
  if (proxyBasePromise) return proxyBasePromise;
  proxyBasePromise = Promise.race([
    api.proxyStatus().then((status) => status.baseUrl || null),
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), PROXY_BASE_TIMEOUT_MS)),
  ])
    .catch(() => null)
    .then((base) => {
      if (!base) proxyBasePromise = null; // allow retry on a later card
      return base;
    });
  return proxyBasePromise;
}

/** Reset hook (tests / config reload can clear the cached base URL). */
export function clearProxyBaseUrl(): void {
  proxyBasePromise = null;
}

export interface ProxiedImage {
  /** Ready-to-use `src`; null while the proxy base is being resolved. */
  src: string | null;
  broken: boolean;
  /**
   * `src` 已就位但图片还没解码完成。
   *
   * 两者必须分开：**「还在加载」与「加载失败」在界面上要能区分**。
   * 上游图床经常很慢（实测 p50 129ms、max 5.2s），或者干脆不可达——
   * 这两种情况如果都画成同一个灰块，用户无法判断是该等还是该换源。
   */
  loading: boolean;
  onError: () => void;
  /** 图片解码完成（成功或失败都算「结束」）。 */
  onLoad: () => void;
}

/**
 * Resolve a TVBox `vod_pic` (possibly carrying inline `@header` suffix) into
 * a `<img>`-ready src routed through Rust's `/image` proxy. While the base
 * URL is resolving `src` stays null so callers render a placeholder instead
 * of firing a doomed direct request (which would trip onError/broken).
 */
export function useProxiedImage(pic: string | undefined): ProxiedImage {
  const [src, setSrc] = useState<string | null>(() => {
    const value = pic?.trim() || "";
    if (!value) return null;
    return needsProxy(value) ? (RESOLVED_SRC.get(value) ?? null) : value;
  });
  const [broken, setBroken] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setBroken(false);
    const value = pic?.trim() || "";
    if (!needsProxy(value)) {
      setSrc(value || null); // data: / relative / empty -> direct
      return;
    }
    // 地址之前算过：直接用，避免重挂载时退回占位符再闪回来。
    const known = RESOLVED_SRC.get(value);
    if (known) {
      setSrc(known);
      return;
    }
    // Wait for the proxy base before rendering, so we never fire a 418 request.
    setSrc(null);
    getProxyBaseUrl().then((base) => {
      const built = buildImageUrl(value, base);
      if (built) {
        rememberResolved(value, built);
      }
      if (alive) setSrc(built);
    });
    return () => {
      alive = false;
    };
  }, [pic]);

  // 新 src 到位即进入「加载中」，直到 onLoad/onError 收尾。
  useEffect(() => {
    if (!src) {
      setLoading(false);
      return;
    }
    setLoading(true);
  }, [src]);

  const onError = useCallback(() => {
    setBroken(true);
    setLoading(false);
  }, []);
  const onLoad = useCallback(() => setLoading(false), []);
  return { src, broken, loading, onError, onLoad };
}
