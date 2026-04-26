// note(justinvdm, 14 Aug 2025): Rendering related imports and logic go here.
// See client.tsx for the actual client entrypoint.

// context(justinvdm, 14 Aug 2025): `react-server-dom-webpack` uses this global
// to load modules, so we need to define it here before importing
// "react-server-dom-webpack."
// prettier-ignore
import "./setWebpackRequire";

import React from "react";

import { hydrateRoot } from "react-dom/client";
import {
  createFromFetch,
  createFromReadableStream,
  encodeReply,
} from "react-server-dom-webpack/client.browser";
import { rscStream } from "rsc-html-stream/client";

export { default as React } from "react";
export type { Dispatch, MutableRefObject, SetStateAction } from "react";
export { ClientOnly } from "./ClientOnly.js";
export { initClientNavigation, navigate } from "./navigation.js";
export type { ActionResponseData } from "./types";

import { getCachedNavigationResponse } from "./navigationCache.js";
import {
  clearStaleAssetGuards,
  performStaleAssetReload,
  readResponseBuildId,
  RWSDK_BUILD_ID,
  RwsdkStaleAssetError,
} from "./staleAsset.js";
import type {
  ActionResponseData,
  HydrationOptions,
  RscActionResponse,
  Transport,
  TransportContext,
} from "./types";
import { isActionResponse } from "./types";

export {
  installVersionPolling,
  RwsdkStaleAssetError,
  STALE_ASSET_EVENT,
  VERSION_ENDPOINT_PATH,
  type InstallVersionPollingOptions,
  type StaleAssetEventDetail,
  type StaleAssetReason,
} from "./staleAsset.js";

export const fetchTransport: Transport = (transportContext) => {
  const fetchCallServer = async <Result,>(
    id: null | string,
    args: null | unknown[],
    source: "action" | "navigation" | "query" = "action",
    method: "GET" | "POST" = "POST",
  ): Promise<Result | undefined> => {
    const url = new URL(window.location.href);
    url.searchParams.set("__rsc", "");

    const isAction = id != null;

    if (isAction) {
      url.searchParams.set("__rsc_action_id", id);

      // If args are provided and method is GET, serialize them into the query string
      if (args != null && method === "GET") {
        url.searchParams.set("args", JSON.stringify(args));
      }
    }

    let fetchPromise: Promise<Response>;

    if (!isAction && source === "navigation") {
      // Try to get cached response first
      const cachedResponse = await getCachedNavigationResponse(url);
      if (cachedResponse) {
        fetchPromise = Promise.resolve(cachedResponse);
      } else {
        // Fall back to network fetch on cache miss
        fetchPromise = fetch(url, {
          method: "GET",
          redirect: "manual",
        });
      }
    } else {
      const headers = new Headers();
      // Add x-rsc-data-only header if we want to skip the React tree render on the server
      if (source === "query") {
        headers.set("x-rsc-data-only", "true");
      }

      if (method === "GET") {
        fetchPromise = fetch(url, {
          method: "GET",
          headers,
          redirect: "manual",
        });
      } else {
        fetchPromise = fetch(url, {
          method: "POST",
          headers,
          redirect: "manual",
          body: args != null ? await encodeReply(args) : null,
        });
      }
    }

    const processActionResponse = (rawActionResult: any) => {
      if (isActionResponse(rawActionResult)) {
        const actionResponse = rawActionResult.__rw_action_response;
        const handledByHook =
          transportContext.onActionResponse?.(actionResponse) === true;

        if (!handledByHook) {
          const location = actionResponse.headers["location"];
          const isRedirect =
            actionResponse.status >= 300 && actionResponse.status < 400;

          if (location && isRedirect) {
            window.location.href = location;
            return undefined;
          }

          if (actionResponse.status >= 400) {
            throw new Error(
              `Server function returned status ${actionResponse.status}`,
            );
          }
        }

        return rawActionResult as Result;
      }

      return rawActionResult as Result;
    };

    // Header-driven stale-asset detection. On RSC deserialization failure,
    // check whether the response advertises a different X-Rwsdk-Build-Id
    // than the one this client was built against. If so, the failure is
    // almost certainly a deploy boundary — surface a typed error and
    // trigger a single guarded reload. Otherwise let the error propagate
    // unchanged.
    const handleAwaitError = (error: unknown, response: Response): never => {
      const serverBuildId = readResponseBuildId(response);
      if (serverBuildId !== null && serverBuildId !== RWSDK_BUILD_ID) {
        const detail = {
          reason: "build-id-mismatch" as const,
          bootBuildId: RWSDK_BUILD_ID,
          serverBuildId,
          error,
        };
        performStaleAssetReload({ detail });
        throw new RwsdkStaleAssetError(detail);
      }
      throw error;
    };

    // If there's a response handler, check the response first
    if (transportContext.handleResponse) {
      const response = await fetchPromise;
      const shouldContinue = transportContext.handleResponse(response);
      if (!shouldContinue) {
        return undefined as any;
      }

      // Keep streamData as the unwrapped Promise that createFromFetch
      // returns. react-server-dom-webpack's thenable carries internal
      // status/value fields that React.use() relies on for streaming;
      // wrapping it (e.g. with .catch) loses those fields and can leave
      // consumers suspended indefinitely. Stale-asset detection is done
      // via try/catch around our own await instead.
      const streamData = createFromFetch(Promise.resolve(response), {
        callServer: fetchCallServer,
      }) as Promise<RscActionResponse<Result>>;

      if (source === "navigation" || source === "action") {
        transportContext.setRscPayload(streamData);
      }
      try {
        const result = await streamData;
        return processActionResponse(
          (result as { actionResult: Result }).actionResult,
        );
      } catch (error) {
        return handleAwaitError(error, response);
      }
    }

    // Original behavior when no handler is present
    const response = await fetchPromise;
    const location = response.headers.get("Location");

    if (response.status >= 300 && response.status < 400 && location) {
      window.location.href = location;
      return undefined as any;
    }

    const streamData = createFromFetch(Promise.resolve(response), {
      callServer: fetchCallServer,
    }) as Promise<RscActionResponse<Result>>;

    if (source === "navigation" || source === "action") {
      transportContext.setRscPayload(streamData);
    }
    try {
      const result = await streamData;
      return processActionResponse(
        (result as { actionResult: Result }).actionResult,
      );
    } catch (error) {
      return handleAwaitError(error, response);
    }
  };

  return fetchCallServer;
};

/**
 * Initializes the React client and hydrates the RSC payload.
 *
 * This function sets up client-side hydration for React Server Components,
 * making the page interactive. Call this from your client entry point.
 *
 * Stale-asset detection: rwsdk listens for Vite's `vite:preloadError` event
 * and compares the `X-Rwsdk-Build-Id` header on RSC responses against the
 * client's build-time identifier; on mismatch it triggers a single guarded
 * full-page reload. Apps can observe via `window.addEventListener('rwsdk:stale-asset', ...)`.
 *
 * @param transport - Custom transport for server communication (defaults to fetchTransport)
 * @param hydrateRootOptions - Options passed to React's `hydrateRoot`. Supports all React hydration options including:
 *                             - `onUncaughtError`: Handler for uncaught errors (async errors, event handler errors).
 *                               If not provided, defaults to logging errors to console.
 *                             - `onCaughtError`: Handler for errors caught by error boundaries
 *                             - `onRecoverableError`: Handler for recoverable errors
 * @param handleResponse - Custom response handler for navigation errors (navigation GETs)
 * @param onHydrated - Callback invoked after a new RSC payload has been committed on the client
 * @param onActionResponse - Optional hook invoked when an action returns a Response;
 *                           return true to signal that the response has been handled and
 *                           default behaviour (e.g. redirects) should be skipped
 *
 * @example
 * // Basic usage
 * import { initClient, initClientNavigation } from "rwsdk/client";
 *
 * // RedwoodSDK uses RSC RPC to emulate client side navigation.
 * // https://docs.rwsdk.com/guides/frontend/client-side-nav/
 * const { handleResponse, onHydrated } = initClientNavigation();
 * initClient({ handleResponse, onHydrated });
 */
export const initClient = async ({
  transport = fetchTransport,
  hydrateRootOptions,
  handleResponse,
  onHydrated,
  onActionResponse,
}: {
  transport?: Transport;
  hydrateRootOptions?: HydrationOptions;
  handleResponse?: (response: Response) => boolean;
  onHydrated?: () => void;
  onActionResponse?: (actionResponse: ActionResponseData) => boolean | void;
} = {}) => {
  // Listen for Vite's preload-error event. Vite dispatches this on
  // dynamic-import preload failures across browsers (Chrome, Firefox,
  // Safari/iOS). When the preload URL points at a chunk that the new
  // server doesn't have, recover via a guarded full reload. See
  // https://vite.dev/guide/build#load-error-handling.
  if (typeof window !== "undefined") {
    window.addEventListener("vite:preloadError", (event) => {
      event.preventDefault();
      performStaleAssetReload({
        detail: {
          reason: "preload-error",
          bootBuildId: RWSDK_BUILD_ID,
          serverBuildId: null,
          error: (event as { payload?: unknown })?.payload,
        },
      });
    });
  }

  const transportContext: TransportContext = {
    setRscPayload: () => { },
    handleResponse,
    onHydrated,
    onActionResponse,
  };

  let transportCallServer = transport(transportContext);

  const callServer = (
    id: any,
    args: any,
    source?: "action" | "navigation" | "query",
    method?: "GET" | "POST",
  ) => {
    return transportCallServer(id, args, source, method);
  };

  const upgradeToRealtime = async ({ key }: { key?: string } = {}) => {
    const { realtimeTransport } = await import("../lib/realtime/client");
    const createRealtimeTransport = realtimeTransport({ key });
    transportCallServer = createRealtimeTransport(transportContext);
  };

  globalThis.__rsc_callServer = callServer;

  globalThis.__rw = {
    callServer,
    upgradeToRealtime,
  };

  const rootEl = document.getElementById("hydrate-root");

  if (!rootEl) {
    throw new Error(
      'RedwoodSDK: No element with id "hydrate-root" found in the document. This element is required for hydration. Ensure your Document component contains a {children}.',
    );
  }

  let rscPayload: any;

  // context(justinvdm, 18 Jun 2025): We inject the RSC payload
  // unless render(Document, [...], { rscPayload: false }) was used.
  if ((globalThis as any).__FLIGHT_DATA) {
    rscPayload = createFromReadableStream(rscStream, {
      callServer,
    });
  }

  function Content() {
    const [streamData, setStreamData] = React.useState(rscPayload);
    const [_isPending, startTransition] = React.useTransition();
    transportContext.setRscPayload = (v) =>
      startTransition(() => {
        setStreamData(v);
      });

    React.useEffect(() => {
      if (!streamData) return;
      // Hydration succeeded against the current deploy, so any prior
      // stale-asset reload guard can be cleared. A future deploy boundary
      // is then allowed to reload again.
      clearStaleAssetGuards();
      transportContext.onHydrated?.();
    }, [streamData]);
    return (
      <>
        {streamData
          ? React.use<{ node: React.ReactNode }>(streamData).node
          : null}
      </>
    );
  }

  hydrateRoot(rootEl, <Content />, {
    onUncaughtError: (error, { componentStack }) => {
      console.error(
        "Uncaught error: %O\n\nComponent stack:%s",
        error,
        componentStack,
      );
    },
    ...hydrateRootOptions,
  });

  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", (e: { file: string }) => {
      console.log("[rwsdk] hot update", e.file);
      callServer("__rsc_hot_update", [e.file]);
    });
  }
};
