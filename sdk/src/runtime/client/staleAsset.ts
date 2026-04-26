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

export type StaleAssetReason =
  | "build-id-mismatch"
  | "preload-error"
  | "version-poll-mismatch";

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

/**
 * URL of the framework's skew-protection endpoint. The framework's worker
 * auto-mounts a route at this path that returns `{ buildId }` with
 * `Cache-Control: no-cache, must-revalidate`.
 */
export const VERSION_ENDPOINT_PATH = "/__rwsdk/version";

export interface InstallVersionPollingOptions {
  /** Endpoint to poll. Defaults to `/__rwsdk/version`. */
  endpoint?: string;
  /** Minimum interval between checks in ms. Defaults to 30s. */
  throttleMs?: number;
  /** Fetch timeout in ms. Defaults to 5s. */
  timeoutMs?: number;
}

/**
 * Optional opt-in proactive deploy-boundary detection. Polls the
 * framework's `/__rwsdk/version` endpoint on `visibilitychange` /
 * `focus` / `pageshow` (bfcache restore) — natural break points where
 * reloading is least disruptive — and triggers a guarded reload if the
 * server reports a different build-id than the client was built against.
 *
 * Without this, deploy boundaries are detected reactively on the next
 * RSC navigation. With it, dormant tabs catch the boundary as soon as
 * the user comes back, before any in-flight RSC request fails.
 *
 * Returns a teardown function that removes the listeners. Safe to call
 * multiple times — the listeners are independent.
 *
 * @example
 * ```ts
 * import { installVersionPolling } from "rwsdk/client";
 * installVersionPolling();
 * ```
 */
export function installVersionPolling(
  options: InstallVersionPollingOptions = {},
): (() => void) | undefined {
  if (typeof window === "undefined") return;

  const endpoint = options.endpoint ?? VERSION_ENDPOINT_PATH;
  const throttleMs = options.throttleMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 5_000;

  let lastCheckedAt = 0;
  let inFlight = false;

  const fetchServerBuildId = async (): Promise<string | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const headerId = readResponseBuildId(response);
      if (headerId) return headerId;
      const body = (await response.json().catch(() => null)) as
        | { buildId?: unknown }
        | null;
      return typeof body?.buildId === "string" ? body.buildId : null;
    } catch {
      // Transient network blips are expected — stay silent. Reactive
      // detection on the next RSC navigation will still catch any real
      // deploy boundary.
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const check = async () => {
    if (inFlight) return;
    const now = Date.now();
    if (now - lastCheckedAt < throttleMs) return;
    lastCheckedAt = now;
    inFlight = true;
    try {
      const serverBuildId = await fetchServerBuildId();
      if (serverBuildId && serverBuildId !== RWSDK_BUILD_ID) {
        performStaleAssetReload({
          detail: {
            reason: "version-poll-mismatch",
            bootBuildId: RWSDK_BUILD_ID,
            serverBuildId,
          },
        });
      }
    } finally {
      inFlight = false;
    }
  };

  const onVisibilityChange = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      void check();
    }
  };
  const onFocus = () => void check();
  const onPageShow = (event: PageTransitionEvent) => {
    // bfcache restore: in-memory bundle may be multiple deploys stale.
    if (event.persisted) void check();
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  window.addEventListener("focus", onFocus);
  window.addEventListener("pageshow", onPageShow);

  return () => {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("pageshow", onPageShow);
  };
}
