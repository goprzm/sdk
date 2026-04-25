import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUILD_ID_HEADER,
  BUILD_ID_META_NAME,
  RwsdkStaleAssetError,
  STALE_ASSET_EVENT,
  bootstrapErrorGuardScript,
  classifyAsStaleAsset,
  clearStaleAssetGuards,
  performStaleAssetReload,
  readBootBuildId,
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
  } as unknown as Storage & { __store: Map<string, string> };
};

describe("staleAsset", () => {
  let sessionStorage: ReturnType<typeof makeSessionStorage>;
  let locationMock: { href: string; reload: ReturnType<typeof vi.fn> };
  let dispatchEvent: ReturnType<typeof vi.fn>;
  let documentMock: { querySelector: ReturnType<typeof vi.fn> };
  let metaContent: string | null;

  beforeEach(() => {
    sessionStorage = makeSessionStorage();
    locationMock = { href: "https://example.com/", reload: vi.fn() };
    dispatchEvent = vi.fn();
    metaContent = null;
    documentMock = {
      querySelector: vi.fn((selector: string) => {
        if (selector === `meta[name="${BUILD_ID_META_NAME}"]`) {
          return metaContent ? { content: metaContent } : null;
        }
        return null;
      }),
    };

    vi.stubGlobal("window", {
      sessionStorage,
      location: locationMock,
      dispatchEvent,
      addEventListener: vi.fn(),
    });
    vi.stubGlobal("document", documentMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("readBootBuildId", () => {
    it("returns the meta tag content when present", () => {
      metaContent = "abc123";
      expect(readBootBuildId(documentMock as unknown as Document)).toBe(
        "abc123",
      );
    });

    it("returns null when the meta tag is absent", () => {
      metaContent = null;
      expect(readBootBuildId(documentMock as unknown as Document)).toBeNull();
    });

    it("returns null for empty/whitespace content", () => {
      metaContent = "   ";
      expect(readBootBuildId(documentMock as unknown as Document)).toBeNull();
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

  describe("classifyAsStaleAsset", () => {
    it("matches Vite/Chrome dynamic-import failures", () => {
      expect(
        classifyAsStaleAsset(
          new Error("Failed to fetch dynamically imported module: /a.js"),
        ),
      ).toBe(true);
    });

    it("matches Safari module-script failures", () => {
      expect(
        classifyAsStaleAsset(new Error("Importing a module script failed")),
      ).toBe(true);
    });

    it("matches webpack chunk-load failures", () => {
      expect(classifyAsStaleAsset(new Error("Loading chunk 7 failed"))).toBe(
        true,
      );
    });

    it("matches stale rwsdk virtual manifest", () => {
      expect(
        classifyAsStaleAsset(
          new Error(
            'Failed to resolve import "/a.js" from "virtual:use-client-lookup.js"',
          ),
        ),
      ).toBe(true);
    });

    it("returns false for unrelated errors", () => {
      expect(classifyAsStaleAsset(new Error("something blew up"))).toBe(false);
    });

    it("handles strings and falsy values without throwing", () => {
      expect(classifyAsStaleAsset(null)).toBe(false);
      expect(classifyAsStaleAsset(undefined)).toBe(false);
      expect(classifyAsStaleAsset("")).toBe(false);
      expect(classifyAsStaleAsset("Loading chunk 1 failed")).toBe(true);
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

    it("does not guard when staleAssetGuard is 'header-only'", () => {
      performStaleAssetReload({
        detail,
        href: "/a",
        guard: "header-only",
      });
      const second = performStaleAssetReload({
        detail,
        href: "/b",
        guard: "header-only",
      });
      expect(second).toBe(true);
      expect(locationMock.href).toBe("/b");
    });

    it("respects an onStaleAsset handler returning false", () => {
      const handler = vi.fn().mockReturnValue(false);
      const reloaded = performStaleAssetReload({
        detail,
        href: "/x",
        onStaleAsset: handler,
      });
      expect(reloaded).toBe(false);
      expect(handler).toHaveBeenCalledWith(detail);
      expect(locationMock.reload).not.toHaveBeenCalled();
    });

    it("still reloads when onStaleAsset handler throws", () => {
      const handler = vi.fn(() => {
        throw new Error("boom");
      });
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const reloaded = performStaleAssetReload({
        detail,
        href: "/x",
        onStaleAsset: handler,
      });
      expect(reloaded).toBe(true);
      consoleSpy.mockRestore();
    });
  });

  describe("clearStaleAssetGuards", () => {
    it("removes both reload guard keys", () => {
      sessionStorage.setItem("rwsdk:build-mismatch-reload", "1");
      sessionStorage.setItem("rwsdk:bootstrap-reload", "1");

      clearStaleAssetGuards();

      expect(sessionStorage.removeItem).toHaveBeenCalledWith(
        "rwsdk:build-mismatch-reload",
      );
      expect(sessionStorage.removeItem).toHaveBeenCalledWith(
        "rwsdk:bootstrap-reload",
      );
    });
  });

  describe("RwsdkStaleAssetError", () => {
    it("captures the detail fields", () => {
      const cause = new Error("inner");
      const error = new RwsdkStaleAssetError({
        reason: "rsc-deserialization-failed",
        bootBuildId: "v1",
        serverBuildId: "v2",
        error: cause,
      });

      expect(error.name).toBe("RwsdkStaleAssetError");
      expect(error.reason).toBe("rsc-deserialization-failed");
      expect(error.bootBuildId).toBe("v1");
      expect(error.serverBuildId).toBe("v2");
      expect(error.cause).toBe(cause);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("bootstrapErrorGuardScript", () => {
    it("contains the documented sessionStorage key", () => {
      expect(bootstrapErrorGuardScript).toContain("rwsdk:bootstrap-reload");
    });

    it("listens for both error and unhandledrejection events", () => {
      expect(bootstrapErrorGuardScript).toContain('"error"');
      expect(bootstrapErrorGuardScript).toContain('"unhandledrejection"');
    });

    it("calls window.location.reload on a match", () => {
      expect(bootstrapErrorGuardScript).toContain("window.location.reload");
    });

    it("contains the documented stale-load patterns", () => {
      expect(bootstrapErrorGuardScript).toMatch(
        /importing a module script failed/i,
      );
      expect(bootstrapErrorGuardScript).toMatch(
        /failed to fetch dynamically imported module/i,
      );
      expect(bootstrapErrorGuardScript).toMatch(/loading chunk/i);
    });
  });
});
