import debug from "debug";
import { Plugin } from "vite";

import { normalizeModulePath } from "../lib/normalizeModulePath.mjs";

const log = debug("rwsdk:vite:directives-filtering-plugin");

function filterDirectiveModules({
  clientFiles,
  serverFiles,
  projectRootDir,
  includedModules,
}: {
  clientFiles: Set<string>;
  serverFiles: Set<string>;
  projectRootDir: string;
  includedModules: Set<string>;
}) {
  process.env.VERBOSE &&
    log(
      "Directive modules before filtering: client=%O, server=%O",
      Array.from(clientFiles),
      Array.from(serverFiles),
    );

  for (const files of [clientFiles, serverFiles]) {
    for (const id of files) {
      const absoluteId = normalizeModulePath(id, projectRootDir, {
        absolute: true,
      });

      if (!includedModules.has(absoluteId)) {
        files.delete(id);
      }
    }
  }

  process.env.VERBOSE &&
    log(
      "Client/server files after filtering: client=%O, server=%O",
      Array.from(clientFiles),
      Array.from(serverFiles),
    );
}

export const directivesFilteringPlugin = ({
  clientFiles,
  serverFiles,
  projectRootDir,
}: {
  clientFiles: Set<string>;
  serverFiles: Set<string>;
  projectRootDir: string;
}): Plugin => {
  return {
    name: "rwsdk:directives-filtering",
    enforce: "post",

    buildEnd() {
      if (
        this.environment.name !== "worker" ||
        process.env.RWSDK_BUILD_PASS !== "worker"
      ) {
        return;
      }

      log("Filtering directive modules after worker build...");

      const includedModules = new Set<string>();
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id) as any;
        if (info && info.isIncluded !== false) {
          includedModules.add(id);
        }
      }

      filterDirectiveModules({
        clientFiles,
        serverFiles,
        projectRootDir,
        includedModules,
      });
    },

    generateBundle(_options, bundle) {
      if (
        this.environment.name !== "worker" ||
        process.env.RWSDK_BUILD_PASS !== "worker"
      ) {
        return;
      }

      log("Filtering directive modules from bundle output...");

      // context(justinvdm, 2026-05-13): Rolldown (Vite 8+) does not expose
      // ModuleInfo.isIncluded. Instead, we inspect the final output chunks.
      // A module whose renderedLength is 0 (or missing) was tree-shaken to
      // empty and should be removed from the directive sets.
      const includedModules = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") {
          continue;
        }

        for (const [moduleId, renderedModule] of Object.entries(
          output.modules,
        )) {
          if (renderedModule.renderedLength > 0) {
            includedModules.add(moduleId);
          }
        }
      }

      filterDirectiveModules({
        clientFiles,
        serverFiles,
        projectRootDir,
        includedModules,
      });
    },
  };
};
