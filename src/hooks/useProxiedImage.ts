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
  onError: () => void;
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

  const onError = useCallback(() => setBroken(true), []);
  return { src, broken, onError };
}
