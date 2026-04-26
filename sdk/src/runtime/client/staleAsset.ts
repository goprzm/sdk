/**
 * Stale-asset detection and recovery primitives.
 *
 * After a deploy, an old client tab may reference JS chunks, RSC client-
 * component IDs, or virtual manifests that no longer exist on the new server.
 * Without intervention this surfaces as a white screen on navigation. The
 * framework detects deploy boundaries via a build-id exchange (a build-time
 * constant compared against the X-Rwsdk-Build-Id header on every server
 * response) and recovers via a single guarded full-page reload, mirroring
 * the pattern used by Next.js (`deploymentId` / `X-Deployment-ID`) and
 * React Router v7 (manifest version check).
 */

declare const __RWSDK_BUILD_ID__: string | undefined;

/**
 * Build-id baked into this bundle at compile time. Compared against the
 * `X-Rwsdk-Build-Id` header on every server response to detect a deploy
 * boundary. See `vite/buildIdPlugin.mts`.
 */
export const RWSDK_BUILD_ID: string =
  typeof __RWSDK_BUILD_ID__ === "string" ? __RWSDK_BUILD_ID__ : "rwsdk";

export const BUILD_ID_HEADER = "x-rwsdk-build-id";
export const STALE_ASSET_EVENT = "rwsdk:stale-asset";

const RELOAD_GUARD_KEY = "rwsdk:stale-asset-reload";

export type StaleAssetReason = "build-id-mismatch" | "preload-error";

export interface StaleAssetEventDetail {
  reason: StaleAssetReason;
  bootBuildId: string;
  serverBuildId: string | null;
  error?: unknown;
}

export class RwsdkStaleAssetError extends Error {
  readonly reason: StaleAssetReason;
  readonly bootBuildId: string;
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

const consumeReloadGuard = (): boolean => {
  const storage = tryGetSessionStorage();
  if (!storage) return false;
  try {
    if (storage.getItem(RELOAD_GUARD_KEY) === "1") {
      storage.removeItem(RELOAD_GUARD_KEY);
      return true;
    }
  } catch {
    return false;
  }
  return false;
};

const setReloadGuard = (): boolean => {
  const storage = tryGetSessionStorage();
  if (!storage) return false;
  try {
    storage.setItem(RELOAD_GUARD_KEY, "1");
    return true;
  } catch {
    return false;
  }
};

/**
 * Clears the reload guard. Called once a navigation commits successfully so
 * a subsequent stale-asset event in the same tab is allowed to reload again.
 */
export const clearStaleAssetGuards = () => {
  const storage = tryGetSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(RELOAD_GUARD_KEY);
  } catch {
    /* ignore */
  }
};

export interface PerformStaleAssetReloadOptions {
  detail: StaleAssetEventDetail;
  /** Optional href to navigate to. Defaults to a `window.location.reload()`. */
  href?: string;
}

/**
 * Performs a single guarded full-page reload to recover from a deploy
 * boundary. Dispatches a `rwsdk:stale-asset` window event for app-level
 * observability before reloading.
 *
 * Loop prevention is primarily server-driven: the `Cache-Control: no-cache,
 * must-revalidate` header on the SSR HTML guarantees the reload fetches
 * fresh HTML and therefore the new build-id. SessionStorage is used as a
 * defensive secondary guard for transient edge-cache races.
 *
 * Returns true if a reload was scheduled, false otherwise. The
 * `window.location` mutation may happen synchronously, so callers should
 * treat a true return as terminal.
 */
export const performStaleAssetReload = (
  options: PerformStaleAssetReloadOptions,
): boolean => {
  if (typeof window === "undefined") return false;

  const { detail, href } = options;

  if (typeof CustomEvent === "function") {
    try {
      window.dispatchEvent(new CustomEvent(STALE_ASSET_EVENT, { detail }));
    } catch {
      /* eventing is best-effort telemetry */
    }
  }

  if (consumeReloadGuard()) {
    // We just reloaded for this same boundary and still see a mismatch —
    // bail out rather than spin. The Cache-Control header on SSR HTML
    // should make this branch unreachable in practice.
    return false;
  }
  setReloadGuard();

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
