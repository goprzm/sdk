import { describe, expect, it, vi, beforeEach } from "vitest";
import { validateClickEvent, initClientNavigation } from "./navigation";

// Mocking browser globals
vi.stubGlobal("window", {
  location: { href: "http://localhost/" },
  addEventListener: vi.fn(),
  history: { scrollRestoration: "auto" },
});

vi.stubGlobal("document", {
  addEventListener: vi.fn(),
});

vi.stubGlobal("history", {
  scrollRestoration: "auto",
});

vi.stubGlobal(
  "Headers",
  class {
    map: Record<string, string> = {};
    constructor(init?: any) {
      if (init && typeof init === "object") {
        for (const key of Object.keys(init)) {
          this.map[key.toLowerCase()] = String(init[key]);
        }
      }
    }
    get(name: string) {
      return this.map[name.toLowerCase()] || null;
    }
    has(name: string) {
      return name.toLowerCase() in this.map;
    }
  },
);

describe("clientNavigation", () => {
  let mockEvent: MouseEvent = {
    button: 0,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
  } as unknown as MouseEvent;
  let mockTarget = {
    closest: () => {
      return {
        getAttribute: () => "/test",
        hasAttribute: () => false,
      };
    },
  } as unknown as HTMLElement;

  it("should return true", () => {
    expect(validateClickEvent(mockEvent, mockTarget)).toBe(true);
  });

  it("should return false if the event is not a left click", () => {
    expect(validateClickEvent({ ...mockEvent, button: 1 }, mockTarget)).toBe(
      false,
    );
  });

  it("none of the modifier keys are pressed", () => {
    expect(
      validateClickEvent({ ...mockEvent, metaKey: true }, mockTarget),
    ).toBe(false);
  });

  it("the target is not an anchor tag", () => {
    expect(
      validateClickEvent(mockEvent, {
        closest: () => undefined,
      } as unknown as HTMLElement),
    ).toBe(false);
  });

  it("should have an href attribute", () => {
    expect(
      validateClickEvent(mockEvent, {
        closest: () => ({ getAttribute: () => undefined }),
      } as unknown as HTMLElement),
    ).toBe(false);
  });

  it("should not include an #hash", () => {
    expect(
      validateClickEvent(mockEvent, {
        closest: () => ({
          getAttribute: () => "/test#hash",
          hasAttribute: () => false,
        }),
      } as unknown as HTMLElement),
    ).toBe(false);
  });

  it("should be a relative link", () => {
    expect(
      validateClickEvent(mockEvent, {
        closest: () => ({
          getAttribute: () => "/test",
          hasAttribute: () => false,
        }),
      } as unknown as HTMLElement),
    ).toBe(true);
  });
});

// Regression tests for issue #1123: onNavigate callback was never called
// Root cause: commit c543ef7 extracted navigate() but dropped onNavigate wiring
describe("onNavigate callback (issue #1123 regression)", () => {
  let capturedClickHandler: ((event: MouseEvent) => void) | null = null;
  let capturedPopstateHandler: (() => void) | null = null;

  beforeEach(() => {
    capturedClickHandler = null;
    capturedPopstateHandler = null;
    vi.clearAllMocks();

    // Capture registered event listeners so we can invoke them manually
    vi.stubGlobal("document", {
      addEventListener: vi.fn((event: string, handler: any) => {
        if (event === "click") capturedClickHandler = handler;
      }),
    });
    vi.stubGlobal("window", {
      location: { href: "http://localhost/" },
      addEventListener: vi.fn((event: string, handler: any) => {
        if (event === "popstate") capturedPopstateHandler = handler;
      }),
      history: {
        scrollRestoration: "auto",
        pushState: vi.fn(),
        replaceState: vi.fn(),
        state: {},
      },
      scrollTo: vi.fn(),
    });
    vi.stubGlobal("history", {
      scrollRestoration: "auto",
      pushState: vi.fn(),
      replaceState: vi.fn(),
      state: {},
    });
    vi.stubGlobal("URL", class {
      href: string;
      constructor(path: string, base: string) {
        this.href = base.replace(/\/$/, "") + path;
      }
    });
    // Assign directly to globalThis without replacing it (avoids breaking Vitest internals)
    (globalThis as any).__rsc_callServer = vi.fn().mockResolvedValue(undefined);
  });

  it("onNavigate is called during link click navigation", async () => {
    const onNavigate = vi.fn();

    initClientNavigation({ onNavigate });

    expect(capturedClickHandler).not.toBeNull();

    const fakeAnchor = {
      getAttribute: (attr: string) => (attr === "href" ? "/about" : null),
      hasAttribute: () => false,
      target: "",
      closest: (sel: string) => (sel === "a" ? fakeAnchor : null),
    };
    const fakeTarget = {
      closest: (sel: string) => (sel === "a" ? fakeAnchor : null),
    };
    const fakeClickEvent = {
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target: fakeTarget,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    await capturedClickHandler!(fakeClickEvent);

    expect(onNavigate).toHaveBeenCalled();
  });

  it("onNavigate is called during popstate navigation", async () => {
    const onNavigate = vi.fn();

    initClientNavigation({ onNavigate });

    expect(capturedPopstateHandler).not.toBeNull();

    await capturedPopstateHandler!();

    expect(onNavigate).toHaveBeenCalled();
  });

  it("onNavigate fires after pushState but before RSC fetch", async () => {
    const callOrder: string[] = [];
    const onNavigate = vi.fn(() => { callOrder.push("onNavigate"); });
    (globalThis as any).__rsc_callServer = vi.fn(() => {
      callOrder.push("rscCallServer");
      return Promise.resolve();
    });

    initClientNavigation({ onNavigate });

    const fakeAnchor = {
      getAttribute: (attr: string) => (attr === "href" ? "/about" : null),
      hasAttribute: () => false,
      target: "",
      closest: (sel: string) => (sel === "a" ? fakeAnchor : null),
    };
    const fakeTarget = {
      closest: (sel: string) => (sel === "a" ? fakeAnchor : null),
    };
    const fakeClickEvent = {
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target: fakeTarget,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    await capturedClickHandler!(fakeClickEvent);

    expect(callOrder).toEqual(["onNavigate", "rscCallServer"]);
    expect(window.history.pushState).toHaveBeenCalled();
  });
});

describe("initClientNavigation", () => {
  beforeEach(() => {
    window.location.href = "http://localhost/";
    vi.clearAllMocks();
  });

  it("handleResponse should follow redirects", () => {
    const { handleResponse } = initClientNavigation();

    const mockResponse = {
      status: 302,
      headers: new Headers({ Location: "/new-page" }),
      ok: false,
    } as unknown as Response;

    const result = handleResponse(mockResponse);

    expect(result).toBe(false);
    expect(window.location.href).toBe("/new-page");
  });

  it("handleResponse should reload on error", () => {
    const { handleResponse } = initClientNavigation();

    const mockResponse = {
      status: 500,
      ok: false,
    } as unknown as Response;

    const result = handleResponse(mockResponse);

    expect(result).toBe(false);
    expect(window.location.href).toBe("http://localhost/");
  });

  it("sets history.scrollRestoration to manual so the browser does not restore scroll before the RSC payload commits", () => {
    history.scrollRestoration = "auto";
    initClientNavigation();
    expect(history.scrollRestoration).toBe("manual");
  });
});

// Stale-asset detection: handleResponse compares X-Rwsdk-Build-Id from RSC
// responses against this client's compile-time RWSDK_BUILD_ID and triggers
// a guarded full-page reload when they diverge. Mirrors the pattern used by
// Next.js (`X-Deployment-ID`) and React Router v7 (manifest version).
describe("handleResponse build-id mismatch", () => {
  // Typed as `any` to keep the test ergonomics simple — vitest's `Mock` type
  // doesn't expose call signatures the way a plain function does.
  let sessionStorage: any;
  let dispatchEvent: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetStaleAssetStateForTests } = await import("./navigation");
    __resetStaleAssetStateForTests();

    const store = new Map<string, string>();
    sessionStorage = {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
    };
    dispatchEvent = vi.fn();

    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
    });
    vi.stubGlobal("window", {
      location: { href: "http://localhost/", reload: vi.fn() },
      addEventListener: vi.fn(),
      history: { scrollRestoration: "auto" },
      sessionStorage,
      dispatchEvent,
    });
    vi.stubGlobal("CustomEvent", class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    });
  });

  // Construct a Response-like object with case-insensitive header lookup
  // matching what handleResponse does via response.headers.get(...).
  const responseWithHeaders = (init: Record<string, string>) =>
    ({
      status: 200,
      ok: true,
      headers: new (globalThis as any).Headers(init),
    }) as unknown as Response;

  it("reloads when the response build-id differs from the client's", () => {
    const { handleResponse } = initClientNavigation();

    // Without Vite's `define`, RWSDK_BUILD_ID resolves to the fallback
    // string "rwsdk". A response with a different build-id is therefore
    // a mismatch.
    const result = handleResponse(
      responseWithHeaders({ "x-rwsdk-build-id": "deploy-v2" }),
    );

    expect(result).toBe(false);
    expect(sessionStorage.setItem).toHaveBeenCalledWith(
      "rwsdk:stale-asset-reload",
      "1",
    );
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const dispatched = dispatchEvent.mock.calls[0]![0] as {
      type: string;
      detail: { reason: string; bootBuildId: string; serverBuildId: string };
    };
    expect(dispatched.type).toBe("rwsdk:stale-asset");
    expect(dispatched.detail.reason).toBe("build-id-mismatch");
    expect(dispatched.detail.bootBuildId).toBe("rwsdk");
    expect(dispatched.detail.serverBuildId).toBe("deploy-v2");
  });

  it("passes through when the response build-id matches the client's", () => {
    const { handleResponse } = initClientNavigation();

    const result = handleResponse(
      responseWithHeaders({ "x-rwsdk-build-id": "rwsdk" }),
    );

    expect(result).toBe(true);
    expect(sessionStorage.setItem).not.toHaveBeenCalledWith(
      "rwsdk:stale-asset-reload",
      "1",
    );
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("passes through when the response carries no build-id header", () => {
    const { handleResponse } = initClientNavigation();

    const result = handleResponse(responseWithHeaders({}));

    expect(result).toBe(true);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("does not double-reload when the guard key is already set", () => {
    sessionStorage.setItem("rwsdk:stale-asset-reload", "1");
    const { handleResponse } = initClientNavigation();

    const result = handleResponse(
      responseWithHeaders({ "x-rwsdk-build-id": "deploy-v2" }),
    );

    // Mismatch was detected but the guard prevented a second reload —
    // handleResponse falls through to "true" so the app at least attempts
    // to render whatever it can rather than spinning.
    expect(result).toBe(true);
  });
});
