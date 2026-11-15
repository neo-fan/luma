import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/invoke";
import { buildImageUrl, needsProxy, normalizePic } from "../lib/imageUrl";

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
/**
 * 聚合搜索一次能出 300+ 张卡，加上首页/收藏/历史，400 条会在整屏还没看完时
 * 就把前面的解析结果挤掉；被挤掉的那些卡再回到视口时会重新走一遍
 * 「无封面 → 骨架 → 图」，看上去就是封面在闪。给到 1200 条足够覆盖一次
 * 搜索的全量结果，单条只占几十字节。
 */
const MAX_RESOLVED_SRC = 1200;

function rememberResolved(pic: string, src: string): void {
  if (RESOLVED_SRC.size >= MAX_RESOLVED_SRC) {
    const oldest = RESOLVED_SRC.keys().next().value;
    if (oldest !== undefined) {
      RESOLVED_SRC.delete(oldest);
    }
  }
  RESOLVED_SRC.set(pic, src);
}

/**
 * 最近一次成功解析到的代理端口。有它之后 `resolveNow` 可以在**渲染期同步**
 * 拼出地址，新建的卡片首帧就带 `<img>`，不必先渲染一帧占位符。
 */
let cachedProxyBase: string | null = null;

/** 已经成功解码过的 src。重挂载/回流时直接跳过骨架，避免同一张图反复闪。 */
const LOADED_SRC = new Set<string>();
const MAX_LOADED_SRC = 1200;

function rememberLoaded(src: string): void {
  if (LOADED_SRC.size >= MAX_LOADED_SRC) {
    const oldest = LOADED_SRC.values().next().value;
    if (oldest !== undefined) {
      LOADED_SRC.delete(oldest);
    }
  }
  LOADED_SRC.add(src);
}

/** 渲染期同步解析：拿不到代理端口时返回 null（首帧占位，随后 effect 补齐）。 */
function resolveNow(value: string): string | null {
  if (!value) return null;
  if (!needsProxy(value)) return value;
  const known = RESOLVED_SRC.get(value);
  if (known) return known;
  if (!cachedProxyBase) return null;
  const built = buildImageUrl(value, cachedProxyBase);
  if (built) rememberResolved(value, built);
  return built;
}

export function getProxyBaseUrl(): Promise<string | null> {
  if (proxyBasePromise) return proxyBasePromise;
  if (cachedProxyBase) return Promise.resolve(cachedProxyBase);
  proxyBasePromise = Promise.race([
    api.proxyStatus().then((status) => status.baseUrl || null),
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), PROXY_BASE_TIMEOUT_MS)),
  ])
    .catch(() => null)
    .then((base) => {
      cachedProxyBase = base;
      if (!base) proxyBasePromise = null; // allow retry on a later card
      return base;
    });
  return proxyBasePromise;
}

/** Reset hook (tests / config reload can clear the cached base URL). */
export function clearProxyBaseUrl(): void {
  proxyBasePromise = null;
  cachedProxyBase = null;
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
  const [src, setSrc] = useState<string | null>(() => resolveNow(normalizePic(pic)));
  const [broken, setBroken] = useState(false);
  // 首帧就对上「已经解码过」的图时不要再叠骨架：同一张卡回流不该再闪一次。
  const [loading, setLoading] = useState(() => src !== null && !LOADED_SRC.has(src));
  /** 代理失败后是否已经试过直连（每个 pic 只重试一次，避免死循环）。 */
  const directRetried = useRef(false);

  useEffect(() => {
    let alive = true;
    directRetried.current = false;
    setBroken(false);
    const value = normalizePic(pic);
    if (!needsProxy(value)) {
      setSrc(value || null); // data: / relative / empty -> direct
      return;
    }
    // 地址之前算过（或代理端口已经在手）：同步拼出来，避免首帧占位再闪回来。
    const ready = resolveNow(value);
    if (ready) {
      setSrc(ready);
      return;
    }
    // 代理端口还没拿到：先占位，等 resolve 后再换成真地址（不发 418 请求）。
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

  // 新 src 到位即进入「加载中」，直到 onLoad/onError 收尾；已解码过的直接放行。
  useEffect(() => {
    if (!src) {
      setLoading(false);
      return;
    }
    setLoading(!LOADED_SRC.has(src));
  }, [src]);

  const onError = useCallback(() => {
    const value = normalizePic(pic);
    // 代理这条路失败时（上游 TLS / 网关问题，本地 `/image` 回 502），直连一次：
    // 普通 CDN 的 <img> 能拿到字节；只有真防盗链的站点会继续失败，那才落入
    // 首字占位。每个 pic 只重试一次，避免 502→直连→失败 的来回抖动。
    if (!directRetried.current && value && needsProxy(value) && src !== value) {
      directRetried.current = true;
      setSrc(value);
      return;
    }
    setBroken(true);
    setLoading(false);
  }, [pic, src]);
  const onLoad = useCallback(() => {
    if (src) rememberLoaded(src);
    setLoading(false);
  }, [src]);
  return { src, broken, loading, onError, onLoad };
}
