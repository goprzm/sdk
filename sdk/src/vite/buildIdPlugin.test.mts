import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetBuildIdForTests,
  buildIdPlugin,
  resolveBuildId,
} from "./buildIdPlugin.mjs";

describe("buildIdPlugin", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    __resetBuildIdForTests();
    delete process.env.RWSDK_BUILD_ID;
    delete process.env.CF_VERSION_METADATA_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    __resetBuildIdForTests();
  });

  describe("resolveBuildId", () => {
    it("prefers RWSDK_BUILD_ID when set", () => {
      process.env.RWSDK_BUILD_ID = "from-env";
      expect(resolveBuildId("production")).toBe("from-env");
    });

    it("falls back to CF_VERSION_METADATA_ID", () => {
      process.env.CF_VERSION_METADATA_ID = "cf-deploy-1";
      expect(resolveBuildId("production")).toBe("cf-deploy-1");
    });

    it("trims surrounding whitespace from env values", () => {
      process.env.RWSDK_BUILD_ID = "  trimmed  ";
      expect(resolveBuildId("production")).toBe("trimmed");
    });

    it("ignores empty/whitespace env values", () => {
      process.env.RWSDK_BUILD_ID = "   ";
      const generated = resolveBuildId("production");
      expect(generated).toMatch(/.+/);
      expect(generated.trim()).not.toBe("");
    });

    it("uses a `dev-` prefix in development mode when no env override is set", () => {
      const id = resolveBuildId("development");
      expect(id).toMatch(/^dev-/);
    });

    it("memoizes the value across calls", () => {
      const first = resolveBuildId("production");
      const second = resolveBuildId("production");
      expect(second).toBe(first);
    });

    it("changes after reset and re-resolution", () => {
      const first = resolveBuildId("production");
      __resetBuildIdForTests();
      // Add a small wait to make sure Date.now()/Math.random() changes.
      const second = resolveBuildId("production");
      expect(second).not.toBe(first);
    });
  });

  describe("buildIdPlugin", () => {
    it("returns a vite plugin with the expected name", () => {
      const plugin = buildIdPlugin();
      expect(plugin.name).toBe("rwsdk:build-id");
      expect(typeof plugin.config).toBe("function");
    });

    it("emits define entries for every environment", () => {
      process.env.RWSDK_BUILD_ID = "fixed-id";
      const plugin = buildIdPlugin();
      const result = (plugin.config as Function).call(
        {},
        {},
        { mode: "production" },
      );

      expect(result.define.__RWSDK_BUILD_ID__).toBe(
        JSON.stringify("fixed-id"),
      );
      for (const env of ["client", "ssr", "worker"] as const) {
        expect(result.environments[env].define.__RWSDK_BUILD_ID__).toBe(
          JSON.stringify("fixed-id"),
        );
      }
    });
  });
});
