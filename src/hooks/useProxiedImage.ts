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
  const [src, setSrc] = useState<string | null>(() =>
    needsProxy(pic) ? null : (pic?.trim() || null),
  );
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
    // Wait for the proxy base before rendering, so we never fire a 418 request.
    setSrc(null);
    getProxyBaseUrl().then((base) => {
      if (alive) setSrc(buildImageUrl(value, base));
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
