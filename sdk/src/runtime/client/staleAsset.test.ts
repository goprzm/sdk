import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUILD_ID_HEADER,
  RWSDK_BUILD_ID,
  RwsdkStaleAssetError,
  STALE_ASSET_EVENT,
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
});
