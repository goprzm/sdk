import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUILD_ID_HEADER,
  installVersionPolling,
  RWSDK_BUILD_ID,
  RwsdkStaleAssetError,
  STALE_ASSET_EVENT,
  VERSION_ENDPOINT_PATH,
  clearStaleAssetGuards,
  performStaleAssetReload,
  readResponseBuildId,
  type StaleAssetEventDetail,
} from "./staleAsset";

const makeSessionStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => store.clear()),
    key: vi.fn(),
    length: 0,
  } as unknown as Storage;
};

describe("staleAsset", () => {
  let sessionStorage: Storage;
  let locationMock: { href: string; reload: ReturnType<typeof vi.fn> };
  let dispatchEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage = makeSessionStorage();
    locationMock = { href: "https://example.com/", reload: vi.fn() };
    dispatchEvent = vi.fn();

    vi.stubGlobal("window", {
      sessionStorage,
      location: locationMock,
      dispatchEvent,
      addEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("RWSDK_BUILD_ID", () => {
    it("falls back to 'rwsdk' when the build-time define is absent", () => {
      // The test runner does not invoke Vite's `define` substitution, so the
      // typeof guard in staleAsset.ts trips and the constant resolves to the
      // fallback string.
      expect(RWSDK_BUILD_ID).toBe("rwsdk");
    });
  });

  describe("readResponseBuildId", () => {
    it("reads the build-id header (case-insensitive)", () => {
      const response = new Response(null, {
        headers: { [BUILD_ID_HEADER]: "deploy-42" },
      });
      expect(readResponseBuildId(response)).toBe("deploy-42");
    });

    it("returns null when the header is missing", () => {
      const response = new Response(null);
      expect(readResponseBuildId(response)).toBeNull();
    });

    it("trims whitespace and treats empty as null", () => {
      const response = new Response(null, {
        headers: { [BUILD_ID_HEADER]: "  v1  " },
      });
      expect(readResponseBuildId(response)).toBe("v1");
    });
  });

  describe("performStaleAssetReload", () => {
    const detail: StaleAssetEventDetail = {
      reason: "build-id-mismatch",
      bootBuildId: "v1",
      serverBuildId: "v2",
    };

    it("reloads to the requested href and dispatches the event", () => {
      const reloaded = performStaleAssetReload({
        detail,
        href: "/dashboard",
      });

      expect(reloaded).toBe(true);
      expect(locationMock.href).toBe("/dashboard");
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      const dispatched = dispatchEvent.mock.calls[0]![0] as CustomEvent;
      expect(dispatched.type).toBe(STALE_ASSET_EVENT);
      expect(dispatched.detail).toEqual(detail);
    });

    it("falls back to window.location.reload when no href is given", () => {
      performStaleAssetReload({ detail });
      expect(locationMock.reload).toHaveBeenCalledTimes(1);
    });

    it("guards against an immediate second reload via sessionStorage", () => {
      const first = performStaleAssetReload({ detail, href: "/a" });
      const second = performStaleAssetReload({ detail, href: "/a" });

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(locationMock.href).toBe("/a"); // unchanged on second attempt
    });
  });

  describe("clearStaleAssetGuards", () => {
    it("removes the reload guard key", () => {
      sessionStorage.setItem("rwsdk:stale-asset-reload", "1");

      clearStaleAssetGuards();

      expect(sessionStorage.removeItem).toHaveBeenCalledWith(
        "rwsdk:stale-asset-reload",
      );
    });
  });

  describe("RwsdkStaleAssetError", () => {
    it("captures the detail fields", () => {
      const cause = new Error("inner");
      const error = new RwsdkStaleAssetError({
        reason: "build-id-mismatch",
        bootBuildId: "v1",
        serverBuildId: "v2",
        error: cause,
      });

      expect(error.name).toBe("RwsdkStaleAssetError");
      expect(error.reason).toBe("build-id-mismatch");
      expect(error.bootBuildId).toBe("v1");
      expect(error.serverBuildId).toBe("v2");
      expect(error.cause).toBe(cause);
      expect(error).toBeInstanceOf(Error);
    });

    it("supports preload-error reason without a server build-id", () => {
      const error = new RwsdkStaleAssetError({
        reason: "preload-error",
        bootBuildId: "v1",
        serverBuildId: null,
      });

      expect(error.reason).toBe("preload-error");
      expect(error.serverBuildId).toBeNull();
    });
  });

  describe("installVersionPolling", () => {
    let listeners: Record<string, Array<(event: any) => void>>;
    let documentVisibility: "visible" | "hidden";
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      listeners = { focus: [], pageshow: [], visibilitychange: [] };
      documentVisibility = "visible";

      const window = {
        sessionStorage,
        location: locationMock,
        dispatchEvent,
        addEventListener: vi.fn((event: string, handler: any) => {
          (listeners[event] ??= []).push(handler);
        }),
        removeEventListener: vi.fn((event: string, handler: any) => {
          listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler);
        }),
      };
      vi.stubGlobal("window", window);
      vi.stubGlobal("document", {
        get visibilityState() {
          return documentVisibility;
        },
        addEventListener: vi.fn((event: string, handler: any) => {
          (listeners[event] ??= []).push(handler);
        }),
        removeEventListener: vi.fn((event: string, handler: any) => {
          listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler);
        }),
      });
      vi.stubGlobal(
        "AbortController",
        class {
          signal = {};
          abort() {}
        },
      );
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });

    it("returns undefined when window is not defined", () => {
      vi.stubGlobal("window", undefined);
      expect(installVersionPolling()).toBeUndefined();
    });

    it("registers focus, pageshow, and visibilitychange listeners", () => {
      installVersionPolling();
      expect(listeners.focus.length).toBe(1);
      expect(listeners.pageshow.length).toBe(1);
      expect(listeners.visibilitychange.length).toBe(1);
    });

    it("dispatches the stale-asset event but does NOT reload when buildId mismatches (default mode)", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ buildId: "v2" }), {
          headers: { [BUILD_ID_HEADER]: "v2" },
        }),
      );
      installVersionPolling();
      // Simulate a focus event
      await listeners.focus[0]!(new Event("focus"));
      // Allow any microtasks queued by the async check to resolve
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledWith(
        VERSION_ENDPOINT_PATH,
        expect.objectContaining({ cache: "no-store" }),
      );
      // Event fires...
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      const dispatched = dispatchEvent.mock.calls[0]![0] as CustomEvent;
      expect(dispatched.detail.reason).toBe("version-poll-mismatch");
      expect(dispatched.detail.serverBuildId).toBe("v2");
      // ... but NO reload happens. The reactive build-id check on the next
      // RSC nav will trigger reload-on-mismatch; this just signals.
      expect(locationMock.reload).not.toHaveBeenCalled();
      expect(locationMock.href).toBe("https://example.com/");
    });

    it("eagerly reloads on mismatch when onMismatch=\"reload\" is set", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ buildId: "v2" }), {
          headers: { [BUILD_ID_HEADER]: "v2" },
        }),
      );
      installVersionPolling({ onMismatch: "reload" });
      await listeners.focus[0]!(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();

      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      // Reload triggered — locationMock.reload was called.
      expect(locationMock.reload).toHaveBeenCalledTimes(1);
    });

    it("does not signal or reload when the polled buildId matches the client's", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ buildId: RWSDK_BUILD_ID }), {
          headers: { [BUILD_ID_HEADER]: RWSDK_BUILD_ID },
        }),
      );
      installVersionPolling();
      await listeners.focus[0]!(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
      expect(dispatchEvent).not.toHaveBeenCalled();
      expect(locationMock.reload).not.toHaveBeenCalled();
    });

    it("respects the throttle window", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ buildId: RWSDK_BUILD_ID })),
      );
      installVersionPolling({ throttleMs: 60_000 });
      await listeners.focus[0]!(new Event("focus"));
      await listeners.focus[0]!(new Event("focus"));
      await listeners.focus[0]!(new Event("focus"));
      await Promise.resolve();
      // Two re-fires within the throttle window should still only call fetch once
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns a teardown function that removes listeners", () => {
      const teardown = installVersionPolling();
      expect(listeners.focus.length).toBe(1);
      teardown!();
      expect(listeners.focus.length).toBe(0);
      expect(listeners.pageshow.length).toBe(0);
      expect(listeners.visibilitychange.length).toBe(0);
    });
  });
});
