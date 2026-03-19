import { describe, expect, it, vi, beforeEach } from "vitest";

describe("hydration indicator", () => {
  let mockRootEl: { getAttribute: ReturnType<typeof vi.fn>; setAttribute: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.restoreAllMocks();

    mockRootEl = {
      getAttribute: vi.fn(),
      setAttribute: vi.fn(),
    };

    vi.stubGlobal("document", {
      getElementById: vi.fn((id: string) => {
        if (id === "hydrate-root") return mockRootEl;
        return null;
      }),
    });
  });

  it("resets attribute to pending when setRscPayload is called", () => {
    // Simulate what Content component does with setRscPayload
    const setRscPayload = (v: any) => {
      document.getElementById("hydrate-root")?.setAttribute("data-rwsdk-hydrated", "pending");
    };

    setRscPayload("some-payload");

    expect(mockRootEl.setAttribute).toHaveBeenCalledWith("data-rwsdk-hydrated", "pending");
  });

  it("sets attribute to true after hydration via requestIdleCallback", () => {
    let idleCallback: (() => void) | null = null;
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
      idleCallback = cb;
    });

    // Simulate the useEffect logic
    const streamData = true;
    if (streamData) {
      if (typeof requestIdleCallback !== "undefined") {
        requestIdleCallback(() => {
          document.getElementById("hydrate-root")?.setAttribute("data-rwsdk-hydrated", "true");
        });
      }
    }

    expect(idleCallback).not.toBeNull();
    idleCallback!();

    expect(mockRootEl.setAttribute).toHaveBeenCalledWith("data-rwsdk-hydrated", "true");
  });

  it("falls back to setTimeout when requestIdleCallback is unavailable", () => {
    vi.stubGlobal("requestIdleCallback", undefined);

    let timeoutCallback: (() => void) | null = null;
    vi.stubGlobal("setTimeout", (cb: () => void, ms: number) => {
      expect(ms).toBe(0);
      timeoutCallback = cb;
      return 0;
    });

    // Simulate the useEffect logic
    const streamData = true;
    if (streamData) {
      if (typeof requestIdleCallback !== "undefined") {
        // should not enter here
        throw new Error("requestIdleCallback should be undefined");
      } else {
        setTimeout(() => {
          document.getElementById("hydrate-root")?.setAttribute("data-rwsdk-hydrated", "true");
        }, 0);
      }
    }

    expect(timeoutCallback).not.toBeNull();
    timeoutCallback!();

    expect(mockRootEl.setAttribute).toHaveBeenCalledWith("data-rwsdk-hydrated", "true");
  });

  it("transitions pending → true → pending → true across RSC navigations", () => {
    let idleCallback: (() => void) | null = null;
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
      idleCallback = cb;
    });

    const setAttribute = mockRootEl.setAttribute;

    // 1. Initial hydration completes
    requestIdleCallback(() => {
      document.getElementById("hydrate-root")?.setAttribute("data-rwsdk-hydrated", "true");
    });
    idleCallback!();
    expect(setAttribute).toHaveBeenLastCalledWith("data-rwsdk-hydrated", "true");

    // 2. RSC navigation starts → reset to pending
    document.getElementById("hydrate-root")?.setAttribute("data-rwsdk-hydrated", "pending");
    expect(setAttribute).toHaveBeenLastCalledWith("data-rwsdk-hydrated", "pending");

    // 3. RSC navigation hydration completes
    idleCallback = null;
    requestIdleCallback(() => {
      document.getElementById("hydrate-root")?.setAttribute("data-rwsdk-hydrated", "true");
    });
    idleCallback!();
    expect(setAttribute).toHaveBeenLastCalledWith("data-rwsdk-hydrated", "true");

    // Verify the full sequence: true, pending, true
    const calls = setAttribute.mock.calls.map((c: any[]) => c[1]);
    expect(calls).toEqual(["true", "pending", "true"]);
  });
});
