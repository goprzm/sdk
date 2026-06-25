import type { Plugin } from "vite";
import { version as viteVersionString } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// context(justinvdm, 2026-06-24):
// This file implements the Vite 7 compatibility shim. The SDK's plugin layer
// is written natively for Vite 8 (Rolldown optimizeDeps, rolldownOptions build
// config, codeSplitting output option). This shim translates those Vite-8-only
// constructs into the Vite 7 equivalents at runtime, so we can support both
// majors from one codebase.
//
// Key points:
// - `configEnvironment` translates per-environment config contributed by other
//   plugins during that hook.
// - `configResolved` re-translates config added late (e.g. by
//   knownDepsResolverPlugin, which needs resolved aliases) and installs live
//   proxies on `build.rolldownOptions` so build-time mutations made by
//   `buildApp.mts` are mirrored into Vite 7's `rollupOptions`.
// - `toEsbuildPlugin` translates Rolldown-shaped optimizeDeps plugins into
//   esbuild plugins, including the null-byte virtual-module convention.
// - See docs/architecture/vite7Compat.md for the full design.

export interface CompatOptions {
  viteVersion?: number;
}

interface OptimizeDepsPlugin {
  name: string;
  resolveId?: (
    id: string,
    importer?: string,
    opts?: { kind?: string },
  ) =>
    | string
    | null
    | undefined
    | { id: string; external?: boolean };
  load?: (id: string) =>
    | string
    | null
    | undefined
    | { code: string; moduleType?: string };
}

const translatedOptimizeDepsPlugins = new WeakMap<
  object,
  WeakSet<OptimizeDepsPlugin>
>();

export function compatTransform(
  plugins: Plugin[],
  options?: CompatOptions,
): Plugin[] {
  const viteMajor =
    options?.viteVersion ?? parseInt(viteVersionString.split(".")[0], 10);

  if (viteMajor >= 8) {
    return plugins;
  }

  return [...plugins, tsconfigPaths(), createVite7CompatPlugin()];
}

function createVite7CompatPlugin(): Plugin {
  return {
    name: "rwsdk:vite7-compat",
    enforce: "post",
    config(config) {
      translateRootConfig(config as any);
    },
    configEnvironment(_env, config) {
      translateEnvironmentConfig(config as any);
    },
    configResolved(config) {
      // context(justinvdm, 2026-06-24): Some plugins add optimizeDeps
      // Rolldown plugins in configResolved after configEnvironment has run.
      // Vite 7 still needs those late plugins translated before the esbuild
      // optimizer runs, especially the dev vendor-barrel redirect plugin.
      translateResolvedConfig(config);
      installRolldownProxies(config as any);
    },
  };
}

function translateRootConfig(config: any) {
  if (config.optimizeDeps) {
    translateOptimizeDeps(config.optimizeDeps);
  }
  if (config.build) {
    translateBuildOptions(config.build);
  }
}

function translateEnvironmentConfig(config: any) {
  if (!config) {
    return;
  }
  if (config.optimizeDeps) {
    translateOptimizeDeps(config.optimizeDeps);
  }
  if (config.build) {
    translateBuildOptions(config.build);
  }
}

function translateResolvedConfig(config: any) {
  translateRootConfig(config);

  if (!config.environments) {
    return;
  }

  for (const env of Object.values(config.environments)) {
    translateEnvironmentConfig(env);
    translateEnvironmentConfig((env as any).config);
  }
}

function translateBuildOptions(build: any) {
  if (build.rolldownOptions == null) {
    return;
  }

  const rolldownOptions = build.rolldownOptions;
  // context(justinvdm, 2026-06-22): Start from a fresh rollupOptions object.
  // Vite 7's environment config merge can share nested output objects across
  // environments, so inheriting an existing rollupOptions.output would cause
  // SSR's entryFileNames to leak into the client build.
  const rollupOptions: any = { ...build.rollupOptions };

  for (const key of Object.keys(rolldownOptions)) {
    if (key === "output") {
      rollupOptions.output = mirrorOutputOptions(rolldownOptions.output);
    } else {
      rollupOptions[key] = rolldownOptions[key];
    }
  }

  build.rollupOptions = rollupOptions;

  build.rolldownOptions = createRolldownOptionsProxy(
    rolldownOptions,
    rollupOptions,
  );

  translateLibOptions(build);
}

function translateLibOptions(build: any) {
  if (build.lib == null || build.lib === false) {
    return;
  }

  build.rollupOptions ??= {};

  const hasInput =
    build.rollupOptions.input != null &&
    (Array.isArray(build.rollupOptions.input)
      ? build.rollupOptions.input.length > 0
      : Object.keys(build.rollupOptions.input).length > 0);

  if (hasInput) {
    return;
  }

  build.rollupOptions.input = build.lib.entry;

  if (build.lib.fileName) {
    // context(justinvdm, 2026-06-22): Vite 7's environment config merge can
    // share the same output object across environments. Create a new object
    // so SSR's entryFileNames do not leak into the client build.
    build.rollupOptions.output = {
      ...(build.rollupOptions.output ?? {}),
    };
    const fileName =
      typeof build.lib.fileName === "function"
        ? build.lib.fileName()
        : build.lib.fileName;
    build.rollupOptions.output.entryFileNames = fileName;
    build.rollupOptions.output.chunkFileNames = fileName;
  }
}

function mirrorOutputOptions(output: any): any {
  if (output == null) {
    return output;
  }
  if (Array.isArray(output)) {
    return output.map(mirrorSingleOutputOptions);
  }
  return mirrorSingleOutputOptions(output);
}

function mirrorSingleOutputOptions(output: any): any {
  if (output == null || typeof output !== "object") {
    return output;
  }

  const result: any = {};
  for (const [key, value] of Object.entries(output)) {
    if (key === "codeSplitting") {
      result.inlineDynamicImports = value === false;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function translateOptimizeDeps(optimizeDeps: any) {
  if (optimizeDeps.rolldownOptions == null) {
    return;
  }

  optimizeDeps.esbuildOptions ??= {};
  const rolldownOptions = optimizeDeps.rolldownOptions;
  const esbuildOptions = optimizeDeps.esbuildOptions;

  if (rolldownOptions.transform) {
    if (rolldownOptions.transform.jsx === "react-jsx") {
      esbuildOptions.jsx = "automatic";
      esbuildOptions.jsxImportSource = "react";
    } else if (rolldownOptions.transform.jsx != null) {
      esbuildOptions.jsx = rolldownOptions.transform.jsx;
    }

    if (rolldownOptions.transform.define) {
      esbuildOptions.define ??= {};
      Object.assign(esbuildOptions.define, rolldownOptions.transform.define);
    }
  }

  if (Array.isArray(rolldownOptions.plugins)) {
    esbuildOptions.plugins ??= [];

    let translatedPlugins = translatedOptimizeDepsPlugins.get(optimizeDeps);
    if (!translatedPlugins) {
      translatedPlugins = new WeakSet<OptimizeDepsPlugin>();
      translatedOptimizeDepsPlugins.set(optimizeDeps, translatedPlugins);
    }

    for (const plugin of rolldownOptions.plugins) {
      if (translatedPlugins.has(plugin)) {
        continue;
      }

      esbuildOptions.plugins.push(toEsbuildPlugin(plugin));
      translatedPlugins.add(plugin);
    }
  }
}

function toEsbuildPlugin(rolldownPlugin: OptimizeDepsPlugin): any {
  return {
    name: rolldownPlugin.name,
    setup(build: any) {
      if (rolldownPlugin.resolveId) {
        build.onResolve({ filter: /.*/ }, async (args: any) => {
          const result = await rolldownPlugin.resolveId!(
            args.path,
            args.importer,
            { kind: args.kind },
          );

          if (result == null) {
            return undefined;
          }

          const id = typeof result === "string" ? result : result.id ?? args.path;
          const hasNullPrefix = id.startsWith("\0");
          const namespace = hasNullPrefix ? rolldownPlugin.name : undefined;
          const path = hasNullPrefix ? id.slice(1) : id;

          return {
            path,
            namespace,
            external: typeof result === "string" ? undefined : result.external,
          };
        });
      }

      if (rolldownPlugin.load) {
        const loadCallback = async (args: any) => {
          const id = args.namespace === rolldownPlugin.name
            ? `\0${args.path}`
            : args.path;
          const result = await rolldownPlugin.load!(id);

          if (result == null) {
            return undefined;
          }

          if (typeof result === "string") {
            return { contents: result };
          }

          return {
            contents: result.code,
            loader: moduleTypeToLoader(result.moduleType),
          };
        };

        build.onLoad({ filter: /.*/, namespace: rolldownPlugin.name }, loadCallback);
        build.onLoad({ filter: /.*/ }, loadCallback);
      }
    },
  };
}

function moduleTypeToLoader(moduleType: string | undefined): string | undefined {
  if (moduleType == null) {
    return undefined;
  }

  switch (moduleType) {
    case "js":
    case "ts":
    case "jsx":
    case "tsx":
      return moduleType;
    default:
      return undefined;
  }
}

function installRolldownProxies(config: any) {
  if (config.build?.rolldownOptions != null) {
    config.build.rolldownOptions = createRolldownOptionsProxy(
      config.build.rolldownOptions,
      config.build.rollupOptions,
    );
  }

  if (config.environments) {
    for (const env of Object.values(config.environments)) {
      const envBuild = (env as any).build ?? (env as any).config?.build;
      if (envBuild?.rolldownOptions != null) {
        envBuild.rolldownOptions = createRolldownOptionsProxy(
          envBuild.rolldownOptions,
          envBuild.rollupOptions,
        );
      }
    }
  }

  // context(justinvdm, 2026-06-22): Vite 7 creates separate environment
  // config objects at build time, so the proxies installed above on the
  // resolved config do not reach the builder.environments[*].config objects
  // that buildApp uses. Wrap builder.buildApp to install proxies on the live
  // builder environments right before our build orchestration runs.
  if (config.builder?.buildApp) {
    const originalBuildApp = config.builder.buildApp;
    config.builder.buildApp = async (builder: any) => {
      installRolldownProxiesOnBuilder(builder);
      return originalBuildApp(builder);
    };
  }
}

function installRolldownProxiesOnBuilder(builder: any) {
  if (builder.config?.build?.rolldownOptions == null) {
    builder.config.build.rolldownOptions = createRolldownOptionsProxy(
      {},
      builder.config.build.rollupOptions,
    );
  }

  if (builder.environments) {
    for (const env of Object.values(builder.environments)) {
      const envBuild = (env as any).config?.build;
      if (envBuild?.rolldownOptions == null) {
        envBuild.rolldownOptions = createRolldownOptionsProxy(
          {},
          envBuild.rollupOptions,
        );
      }
    }
  }
}

function createRolldownOptionsProxy(
  rolldownOptions: any,
  rollupOptions: any,
): any {
  rollupOptions ??= {};

  return new Proxy(rolldownOptions, {
    get(_target, prop, _receiver) {
      if (prop === "output") {
        if (rollupOptions.output == null) {
          rollupOptions.output = {};
        }
        return createOutputProxy(rolldownOptions.output, rollupOptions.output);
      }

      const value = Reflect.get(rollupOptions, prop, rollupOptions);
      if (typeof value === "function") {
        return value.bind(rollupOptions);
      }
      return value;
    },
    set(_target, prop, value, _receiver) {
      if (prop === "output") {
        rollupOptions.output = mirrorOutputOptions(value);
        return true;
      }
      return Reflect.set(rollupOptions, prop, value, rollupOptions);
    },
    has(_target, prop) {
      return Reflect.has(rollupOptions, prop);
    },
    ownKeys(_target) {
      return Reflect.ownKeys(rollupOptions);
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(rollupOptions, prop);
    },
  });
}

function createOutputProxy(rolldownOutput: any, rollupOutput: any): any {
  if (Array.isArray(rolldownOutput)) {
    rollupOutput = ensureArray(rollupOutput);

    return new Proxy(rolldownOutput, {
      get(_target, prop) {
        if (prop === "length") {
          return rollupOutput.length;
        }

        const index = Number(prop);
        if (!Number.isNaN(index)) {
          return createSingleOutputProxy(
            rolldownOutput[index],
            rollupOutput[index],
          );
        }

        const value = Reflect.get(rollupOutput, prop, rollupOutput);
        if (typeof value === "function") {
          return value.bind(rollupOutput);
        }
        return value;
      },
      set(_target, prop, value) {
        if (prop === "length") {
          rollupOutput.length = value;
          return true;
        }

        const index = Number(prop);
        if (!Number.isNaN(index)) {
          rollupOutput[index] = mirrorSingleOutputOptions(value);
          return true;
        }

        return Reflect.set(rollupOutput, prop, value, rollupOutput);
      },
      has(_target, prop) {
        return Reflect.has(rollupOutput, prop);
      },
      ownKeys(_target) {
        return Reflect.ownKeys(rollupOutput);
      },
      getOwnPropertyDescriptor(_target, prop) {
        return Reflect.getOwnPropertyDescriptor(rollupOutput, prop);
      },
    });
  }

  return createSingleOutputProxy(
    rolldownOutput ?? {},
    rollupOutput ?? {},
  );
}

function ensureArray(value: any): any[] {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function createSingleOutputProxy(
  rolldownSingle: any,
  rollupSingle: any,
): any {
  rollupSingle ??= {};

  return new Proxy(rolldownSingle, {
    get(_target, prop) {
      if (prop === "codeSplitting") {
        return rollupSingle.inlineDynamicImports === true ? false : true;
      }

      const value = Reflect.get(rollupSingle, prop, rollupSingle);
      if (typeof value === "function") {
        return value.bind(rollupSingle);
      }
      return value;
    },
    set(_target, prop, value) {
      if (prop === "codeSplitting") {
        rollupSingle.inlineDynamicImports = value === false;
        return true;
      }
      return Reflect.set(rollupSingle, prop, value, rollupSingle);
    },
    has(_target, prop) {
      return Reflect.has(rollupSingle, prop);
    },
    ownKeys(_target) {
      return Reflect.ownKeys(rollupSingle);
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(rollupSingle, prop);
    },
  });
}
