import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { compatTransform } from "./viteCompat.mjs";

interface TestRolldownPlugin {
  name: string;
  resolveId(id: string): string | undefined;
}

interface TestEsbuildPlugin {
  name: string;
  setup(build: {
    onResolve(
      options: unknown,
      callback: (args: { path: string; importer?: string; kind?: string }) => unknown,
    ): void;
  }): unknown;
}

interface TestEnvironmentConfig {
  optimizeDeps: {
    rolldownOptions: {
      plugins: TestRolldownPlugin[];
    };
    esbuildOptions?: {
      plugins: TestEsbuildPlugin[];
    };
  };
}

function getHookHandler<TArgs extends unknown[]>(
  hook: unknown,
): (...args: TArgs) => unknown {
  if (typeof hook === "function") {
    return hook as (...args: TArgs) => unknown;
  }

  if (hook && typeof hook === "object" && "handler" in hook) {
    const handler = hook.handler;
    if (typeof handler === "function") {
      return handler as (...args: TArgs) => unknown;
    }
  }

  throw new Error("Expected plugin hook to be registered");
}

function getCompatPlugin(): Plugin {
  const plugins = compatTransform([], { viteVersion: 7 });
  const compatPlugin = plugins.find(
    (plugin): plugin is Plugin => plugin?.name === "rwsdk:vite7-compat",
  );

  if (!compatPlugin) {
    throw new Error("Expected Vite 7 compat plugin to be present");
  }

  return compatPlugin;
}

describe("viteCompat", () => {
  it("translates optimizeDeps plugins added after configEnvironment", async () => {
    const firstPlugin: TestRolldownPlugin = {
      name: "first",
      resolveId(id: string) {
        if (id === "first") {
          return "first-result";
        }
      },
    };
    const latePlugin: TestRolldownPlugin = {
      name: "late",
      resolveId(id: string) {
        if (id === "late") {
          return "\0late-result";
        }
      },
    };
    const environmentConfig: TestEnvironmentConfig = {
      optimizeDeps: {
        rolldownOptions: {
          plugins: [firstPlugin],
        },
      },
    };
    const compatPlugin = getCompatPlugin();
    const configEnvironment = getHookHandler<[
      string,
      TestEnvironmentConfig,
    ]>(compatPlugin.configEnvironment);
    const configResolved = getHookHandler<[
      { environments: { worker: TestEnvironmentConfig } },
    ]>(compatPlugin.configResolved);

    await configEnvironment("worker", environmentConfig);
    expect(environmentConfig.optimizeDeps.esbuildOptions?.plugins).toHaveLength(
      1,
    );

    environmentConfig.optimizeDeps.rolldownOptions.plugins.push(latePlugin);
    await configResolved({ environments: { worker: environmentConfig } });

    const esbuildPlugins = environmentConfig.optimizeDeps.esbuildOptions?.plugins;
    expect(esbuildPlugins).toHaveLength(2);
    if (!esbuildPlugins?.[1]) {
      throw new Error("Expected late esbuild plugin to be translated");
    }

    const resolveCallbacks: Array<
      (args: { path: string; importer?: string; kind?: string }) => unknown
    > = [];
    await esbuildPlugins[1].setup({
      onResolve(
        _options: unknown,
        callback: (args: {
          path: string;
          importer?: string;
          kind?: string;
        }) => unknown,
      ) {
        resolveCallbacks.push(callback);
      },
    });

    await expect(resolveCallbacks[0]({ path: "late" })).resolves.toEqual({
      path: "late-result",
      namespace: "late",
      external: undefined,
    });
  });
});
