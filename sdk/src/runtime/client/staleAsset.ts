/**
 * Stale-asset detection and recovery primitives.
 *
 * After a deploy, an old client may reference JS chunks, RSC client-component
 * IDs, or virtual manifests that no longer exist on the new server. Without
 * intervention this surfaces as a white screen on navigation. This module
 * provides the shared building blocks the SDK uses to detect deploy boundaries
 * and trigger a single guarded full-page reload.
 *
 * Detection happens in three places, all routed through here:
 *   1. `navigation.ts:handleResponse` compares `X-Rwsdk-Build-Id` from RSC
 *      responses against the boot-time build-id read from the meta tag.
 *   2. `client.tsx` wraps `createFromFetch` and routes its rejections through
 *      `classifyAsStaleAsset` to catch chunk-load failures during RSC
 *      deserialization.
 *   3. The pre-hydrate inline script (see `bootstrapErrorGuardScript`) catches
 *      bootstrap-time module-script failures before any client code has run.
 */

export const BUILD_ID_META_NAME = "rwsdk-build-id";
export const BUILD_ID_HEADER = "x-rwsdk-build-id";

export const STALE_ASSET_EVENT = "rwsdk:stale-asset";

const BUILD_MISMATCH_RELOAD_KEY = "rwsdk:build-mismatch-reload";
const BOOTSTRAP_RELOAD_KEY = "rwsdk:bootstrap-reload";

export type StaleAssetGuardMode = "session-storage" | "header-only";

export type StaleAssetReason =
  | "build-id-mismatch"
  | "rsc-deserialization-failed"
  | "bootstrap-module-script-failed";

export interface StaleAssetEventDetail {
  reason: StaleAssetReason;
  bootBuildId: string | null;
  serverBuildId: string | null;
  error?: unknown;
}

export type StaleAssetHandler = (
  detail: StaleAssetEventDetail,
) => boolean | void;

export class RwsdkStaleAssetError extends Error {
  readonly reason: StaleAssetReason;
  readonly bootBuildId: string | null;
  readonly serverBuildId: string | null;
  readonly cause?: unknown;

  constructor(detail: StaleAssetEventDetail) {
    super(`rwsdk: stale asset detected (${detail.reason})`);
    this.name = "RwsdkStaleAssetError";
    this.reason = detail.reason;
    this.bootBuildId = detail.bootBuildId;
    this.serverBuildId = detail.serverBuildId;
    if (detail.error !== undefined) {
      this.cause = detail.error;
    }
  }
}

export const readBootBuildId = (
  doc: Document | undefined = typeof document !== "undefined"
    ? document
    : undefined,
): string | null => {
  if (!doc) return null;
  const meta = doc.querySelector(
    `meta[name="${BUILD_ID_META_NAME}"]`,
  ) as HTMLMetaElement | null;
  const value = meta?.content?.trim();
  return value && value.length > 0 ? value : null;
};

export const readResponseBuildId = (response: Response): string | null => {
  const value = response.headers.get(BUILD_ID_HEADER);
  return value && value.trim().length > 0 ? value.trim() : null;
};

const tryGetSessionStorage = (): Storage | null => {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
};

const consumeReloadGuard = (key: string): boolean => {
  const storage = tryGetSessionStorage();
  if (!storage) return false;
  try {
    if (storage.getItem(key) === "1") {
      storage.removeItem(key);
      return true;
    }
  } catch {
    return false;
  }
  return false;
};

const setReloadGuard = (key: string): boolean => {
  const storage = tryGetSessionStorage();
  if (!storage) return false;
  try {
    storage.setItem(key, "1");
    return true;
  } catch {
    return false;
  }
};

/**
 * Clears all stale-asset reload guards. Called once hydration succeeds so a
 * subsequent stale-asset event in the same tab is allowed to reload again.
 */
export const clearStaleAssetGuards = () => {
  const storage = tryGetSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(BUILD_MISMATCH_RELOAD_KEY);
    storage.removeItem(BOOTSTRAP_RELOAD_KEY);
  } catch {
    /* ignore */
  }
};

export interface PerformStaleAssetReloadOptions {
  detail: StaleAssetEventDetail;
  href?: string;
  guard?: StaleAssetGuardMode;
  onStaleAsset?: StaleAssetHandler;
  guardKey?: string;
}

/**
 * Dispatches the stale-asset event and, unless the host application opts out,
 * performs a single guarded full-page reload.
 *
 * Returns true if a reload was scheduled, false otherwise. The actual
 * `window.location` mutation may happen synchronously, so callers should treat
 * a true return as terminal.
 */
export const performStaleAssetReload = (
  options: PerformStaleAssetReloadOptions,
): boolean => {
  if (typeof window === "undefined") return false;

  const {
    detail,
    href,
    guard = "session-storage",
    onStaleAsset,
    guardKey = BUILD_MISMATCH_RELOAD_KEY,
  } = options;

  if (typeof CustomEvent === "function") {
    try {
      window.dispatchEvent(new CustomEvent(STALE_ASSET_EVENT, { detail }));
    } catch {
      /* ignore — eventing is best-effort telemetry */
    }
  }

  if (onStaleAsset) {
    try {
      const handlerResult = onStaleAsset(detail);
      if (handlerResult === false) {
        return false;
      }
    } catch (handlerError) {
      console.error("rwsdk: onStaleAsset handler threw", handlerError);
    }
  }

  if (guard === "session-storage") {
    if (consumeReloadGuard(guardKey)) {
      // We just reloaded for this same boundary and still see a mismatch —
      // bail out rather than spin. Cache-Control on the SSR HTML should make
      // this branch unreachable in practice; it exists for transient edge
      // caching races.
      return false;
    }
    setReloadGuard(guardKey);
  }

  try {
    if (href) {
      window.location.href = href;
    } else {
      window.location.reload();
    }
  } catch (reloadError) {
    console.error("rwsdk: reload failed", reloadError);
    return false;
  }
  return true;
};

const STALE_ASSET_MESSAGE_PATTERNS: RegExp[] = [
  /importing a module script failed/i,
  /failed to fetch dynamically imported module/i,
  /dynamically imported module/i,
  /loading chunk \d+ failed/i,
  /chunkloaderror/i,
  /failed to resolve module specifier/i,
  /virtual:use-client-lookup/i,
];

/**
 * Heuristic classifier for runtime errors caught around dynamic imports / RSC
 * deserialization. Used by the `createFromFetch` wrapper to decide whether to
 * upgrade a generic error into an `RwsdkStaleAssetError`.
 *
 * The patterns intentionally focus on browser-native module-load failures.
 * The build-id header check (`navigation.handleResponse`) is the primary,
 * deterministic detection path; this is the secondary path for cases where a
 * stale chunk URL is dereferenced before any header is observed.
 */
export const classifyAsStaleAsset = (error: unknown): boolean => {
  if (!error) return false;
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  if (!message) return false;
  return STALE_ASSET_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
};

/**
 * Inline script body injected into the SSR document `<head>`. It listens for
 * unhandled errors before hydration completes and forces a single reload if
 * the failure looks like a stale module-script load. Kept tiny on purpose:
 * patterns are duplicated rather than imported because this script must run
 * before any module loads.
 */
export const bootstrapErrorGuardScript = `(()=>{try{var K="${BOOTSTRAP_RELOAD_KEY}";var s=window.sessionStorage;var P=[/importing a module script failed/i,/failed to fetch dynamically imported module/i,/dynamically imported module/i,/loading chunk \\d+ failed/i,/chunkloaderror/i];function m(e){if(!e)return false;var x=typeof e==="string"?e:(e&&e.message)||"";return P.some(function(p){return p.test(x);});}function h(e){var t=(e&&(e.reason||e.error||e.message))||e;if(!m(t))return;try{if(s&&s.getItem(K)==="1")return;if(s)s.setItem(K,"1");}catch(_){}try{window.location.reload();}catch(_){}}window.addEventListener("error",h,true);window.addEventListener("unhandledrejection",h);}catch(_){}})();`;
