import { Plugin } from "vite";

const ENV_OVERRIDE_KEYS = ["RWSDK_BUILD_ID", "CF_VERSION_METADATA_ID"] as const;

let cachedBuildId: string | undefined;

const generateBuildId = (mode: string): string => {
  for (const key of ENV_OVERRIDE_KEYS) {
    const fromEnv = process.env[key];
    if (fromEnv && fromEnv.trim().length > 0) {
      return fromEnv.trim();
    }
  }

  if (mode === "development") {
    return `dev-${Date.now().toString(36)}`;
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export const resolveBuildId = (mode: string = "production"): string => {
  if (!cachedBuildId) {
    cachedBuildId = generateBuildId(mode);
  }
  return cachedBuildId;
};

export const __resetBuildIdForTests = () => {
  cachedBuildId = undefined;
};

export const buildIdPlugin = (): Plugin => {
  return {
    name: "rwsdk:build-id",
    config(_userConfig, env) {
      const buildId = resolveBuildId(env.mode);
      const stringified = JSON.stringify(buildId);

      // Use a plain global identifier (`__RWSDK_BUILD_ID__`) rather than
      // `import.meta.env.RWSDK_BUILD_ID`. Vite's define applies inconsistently
      // to `import.meta.env.X` references inside deeply-imported package
      // files (e.g. compiled rwsdk modules under node_modules). A plain
      // identifier is replaced as a simple lexical substitution everywhere.
      return {
        define: {
          __RWSDK_BUILD_ID__: stringified,
        },
        environments: {
          client: {
            define: {
              __RWSDK_BUILD_ID__: stringified,
            },
          },
          ssr: {
            define: {
              __RWSDK_BUILD_ID__: stringified,
            },
          },
          worker: {
            define: {
              __RWSDK_BUILD_ID__: stringified,
            },
          },
        },
      };
    },
  };
};
