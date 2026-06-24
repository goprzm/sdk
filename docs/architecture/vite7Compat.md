# Vite 7 Compatibility Shim

This document explains how RedwoodSDK supports both Vite 8 and Vite 7 from a single, Vite-8-native plugin codebase.

## Why a shim exists

The SDK's Vite plugin layer is written for Vite 8. It uses Vite 8-specific APIs and conventions, in particular:

- `optimizeDeps.rolldownOptions` (Rolldown-based dependency optimization plugins and transforms).
- `build.rolldownOptions` (Rolldown build options).
- `output.codeSplitting: false` (Rolldown output option).

These do not exist in Vite 7. Rather than maintaining two plugin implementations, we transform the Vite-8-native config into the Vite-7-equivalent form at runtime. The transformation is implemented in `sdk/src/vite/viteCompat.mts`.

## What the shim does

The shim is a single Vite plugin, `rwsdk:vite7-compat`, with `enforce: "post"` so it runs after all other SDK plugins have contributed their config. It operates in three phases.

### Phase 1: `config` — root-level translation

The `config` hook translates the root-level `optimizeDeps` and `build` options. Most of the SDK's config is per-environment, so this phase is small.

### Phase 2: `configEnvironment` — per-environment translation

The `configEnvironment` hook translates each environment's `optimizeDeps.rolldownOptions` and `build.rolldownOptions` into the Vite 7 equivalents:

- `optimizeDeps.rolldownOptions.transform` → `esbuildOptions.jsx`, `esbuildOptions.jsxImportSource`, and `esbuildOptions.define`.
- `optimizeDeps.rolldownOptions.plugins` → `esbuildOptions.plugins`.
- `build.rolldownOptions` → `build.rollupOptions`.
- `output.codeSplitting: false` → `output.inlineDynamicImports: true`.
- `build.lib` → `rollupOptions.input` / `entryFileNames`.

This hook runs while Vite is still assembling environment configs, so it is the right place to translate options that other plugins contribute during `configEnvironment`.

### Phase 3: `configResolved` — late translation and live proxies

Some SDK plugins mutate config in `configResolved` rather than `configEnvironment`. `knownDepsResolverPlugin`, for example, needs resolved aliases and therefore installs its `optimizeDeps` plugin in `configResolved`. The shim re-translates any new `rolldownOptions` content in `configResolved` so those late plugins are also converted for Vite 7.

To avoid double-translating the same plugin, the shim keeps a `WeakSet` per `optimizeDeps` object.

Finally, the shim installs **live proxies** on `build.rolldownOptions`. This is needed because the production build orchestrator (`buildApp.mts`) mutates `rolldownOptions` at build time, long after all config hooks have finished. On Vite 8 those mutations are read by Rolldown; on Vite 7 there is no `rolldownOptions`, so the proxy mirrors each mutation into the corresponding `rollupOptions` field.

## Why some plugins add optimizeDeps plugins in `configResolved`

`configEnvironment` receives the environment config before Vite has resolved aliases. `configResolved` receives the fully resolved config. Plugins that need resolved aliases or that operate on the final environment object therefore do their work in `configResolved`.

The shim's `configResolved` re-translation makes this safe for Vite 7: the Rolldown-shaped plugin is converted to an esbuild plugin after it has been added, but before Vite 7's dependency optimizer consumes the config.

## Translating Rolldown optimizeDeps plugins to esbuild

The most intricate part of the shim is translating a Rolldown `resolveId`/`load` plugin into an esbuild plugin.

Rolldown and esbuild have different virtual-module conventions:

- In Rolldown, a plugin can return a string starting with `\0` (e.g. `\0virtual:foo`) from `resolveId` to mark a virtual module.
- In esbuild, virtual modules are represented by a `{ path, namespace }` pair; `\0` is not a valid path prefix.

The shim therefore inspects the resolved id. If it starts with `\0`, it strips the prefix and sets the esbuild `namespace` to the plugin's own name. The corresponding `onLoad` hook reconstructs the original `\0`-prefixed id when calling the Rolldown `load` function.

## Slugged optimize-dep entry IDs

Vite 7 turns optimize-dep entry specifiers into file-system-safe slugs. For example, `rwsdk/__vendor_client_barrel` becomes `rwsdk___vendor_client_barrel` in `node_modules/.vite`. The esbuild optimizer may ask a plugin about either the original specifier or the slugged one. Plugins that intercept stable specifiers therefore need to match both forms. This is handled in the plugins themselves (e.g. `directiveModulesDevPlugin`), not in the shim.

## Keeping the shim small

The shim deliberately does not replicate every Rolldown feature. It only translates the exact patterns the SDK uses. If the SDK's Vite-8-native plugins change, the shim may need to change with them. The goal is to keep the Vite 8 code path clean and native, while making the Vite 7 path a mechanical translation.
