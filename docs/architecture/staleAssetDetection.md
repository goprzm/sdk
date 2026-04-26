---
title: Stale-Asset Detection at Deploy Boundaries
description: How RedwoodSDK detects and recovers from deploy boundaries — when an old client tab references JS chunks or RSC client-component IDs that no longer exist on the new server.
---

## Problem

After a fresh deploy, an old client tab still has the previous build's JS module graph baked into closures and React Server DOM Webpack's module map. On the next client-driven navigation, three classes of failure are possible:

1. **Dynamic-import 404s.** `import("/assets/Foo-abc123.js")` references chunks that no longer exist at the new build's content-hashed URLs.
2. **`virtual:use-client-lookup` mismatches.** RSC payloads from the new server reference client-component IDs that the old client's virtual lookup module doesn't have.
3. **Bootstrap-time script 404s.** Mid-CDN-propagation, the entry HTML loads but `client.tsx` itself 404s before any client code runs — silent white screen.

Cloudflare Workers' asset binding has zero grace period; once a new deploy is live, old chunks return 404 immediately.

The dev-only `staleDepRetryPlugin` handles a related but different problem (Vite's dev-time dependency re-optimization) and does not run in production. This document describes the production mechanism.

## Solution

A build-id is exchanged between server and client at navigation boundaries. **One detection primitive (response header), three recovery surfaces, one reload helper.** The pattern mirrors Next.js's [`deploymentId`](https://nextjs.org/docs/app/api-reference/config/next-config-js/deploymentId) / `X-Deployment-ID` and React Router v7's [`/__manifest`](https://github.com/remix-run/react-router/blob/main/packages/react-router/lib/dom/ssr/fog-of-war.ts) version check, adapted for Cloudflare Workers' asset binding.

### Build-id generation

A Vite plugin (`vite/buildIdPlugin.mts`) generates a stable build-id at config-resolve time. It honors `RWSDK_BUILD_ID` and `CF_VERSION_METADATA_ID` env overrides, otherwise generates a per-build value. The build-id is substituted into all environments (worker, client, ssr) via the `__RWSDK_BUILD_ID__` global identifier — Vite's `define` for plain identifiers is a simple lexical substitution that applies uniformly across deeply-imported package files (which `import.meta.env.X` does not, by experience).

The constant is exported as `RWSDK_BUILD_ID` from `runtime/client/staleAsset.ts` and imported by `worker.tsx`, `navigation.ts`, and `navigationCache.ts` for a single source of truth.

### Server-side: response header + version endpoint

Two server-side surfaces:

1. **`X-Rwsdk-Build-Id` response header.** Set on every RSC response and SSR HTML response in `runtime/worker.tsx`. Gives the client a per-response signal of the current deploy.
2. **`/__rwsdk/version` endpoint.** Auto-mounted by `defineApp`. Returns `{ buildId }` with framework-controlled `Cache-Control: no-cache, must-revalidate`. The framework owns this URL, so it can mandate cache policy on it without conflicting with the application's own HTML caching strategy. Used by the optional client-side polling helper.

### Client-side: three recovery surfaces, one reload helper

All three surfaces feed `performStaleAssetReload` in `runtime/client/staleAsset.ts`, which dispatches a `rwsdk:stale-asset` window event for app-level observability and then performs a single sessionStorage-guarded full-page reload (`window.location.href = ...`).

1. **`vite:preloadError` listener** — registered as the first line of `initClient()`. Vite dispatches this event cross-browser (Chrome `Failed to fetch dynamically imported module`, Firefox `error loading dynamically imported module`, Safari/iOS `Importing a module script failed`) for any dynamic-import preload failure. Catches case 1 above. Documented at [vite.dev/guide/build#load-error-handling](https://vite.dev/guide/build#load-error-handling).

2. **`handleResponse` build-id check** — in `runtime/client/navigation.ts`, on every RSC response, compares `X-Rwsdk-Build-Id` against the client's compile-time `RWSDK_BUILD_ID`. On mismatch, reloads to the *pending nav target* (preserves user intent rather than dropping the user back at the page they navigated from). Catches case 2.

3. **`createFromFetch` await wrapper** — in `runtime/client/client.tsx`, the await around the streaming RSC payload is wrapped in a try/catch that does the same header check on RSC deserialization failure. Belt-and-suspenders for case 2 when the failure surfaces as a thrown error rather than a header mismatch on a 200 response.

A pre-hydrate inline script (which would catch case 3) is intentionally **not** injected by the framework. Apps that need bootstrap-time recovery for client-script 404s should rely on `Cache-Control: no-cache` on entry HTML so the next refresh by the user fetches fresh HTML pointing at the new entry-script URL. None of the surveyed production frameworks (Next.js, React Router v7, SvelteKit, Astro) inject pre-hydrate guards either.

### Optional: proactive polling

`installVersionPolling()` (exported from `rwsdk/client`) is opt-in. When called, it registers `visibilitychange` / `focus` / `pageshow` (bfcache restore) listeners that fetch `/__rwsdk/version` (throttled to 30s by default) and trigger the same reload helper on mismatch. This catches deploy boundaries on dormant tabs *before* the user's next interaction triggers an RSC navigation.

```ts
import { installVersionPolling } from "rwsdk/client";

const teardown = installVersionPolling();
// optional: teardown?.()
```

### Loop prevention

Recovery is sessionStorage-guarded (`rwsdk:stale-asset-reload` key). On a successful navigation commit, the guard is cleared so a future deploy boundary in the same tab can reload again. The guard ensures at most one reload per detected boundary per tab, which is the pattern Next.js (URL-equality in `handleHardNavigation`) and React Router v7 (sessionStorage flag) both use.

For the *recovery* path to land cleanly on a fresh bundle, the entry HTML the framework reloads to must not be a stale edge-cached response. Apps that want guaranteed clean recovery should configure their CDN / Worker to revalidate entry HTML per request (e.g. `Cache-Control: no-cache, must-revalidate`). The framework does **not** set this header for the application — cache policy on app-owned URLs is application/CDN territory, mirroring how Next.js, Remix, and SvelteKit document the requirement rather than imposing it.

## Why a full reload, not transparent retry

A full browser reload is required because the running JS module graph has stale chunk URLs already baked into closures and the React Server DOM Webpack module map. Transparent in-place chunk re-fetch is possible in principle but requires monkey-patching `__webpack_require__.f.j` (the chunk loader function), which is brittle and tightly coupled to React internals. Vite's [note](https://vite.dev/guide/build#load-error-handling) about [whatwg/html#6768](https://github.com/whatwg/html/issues/6768) documents the same constraint.

The typed `RwsdkStaleAssetError` event in this design is the integration point if in-place recovery becomes feasible later — apps could opt into it via the `rwsdk:stale-asset` event handler.

## Comparison with other frameworks

| Framework | Detection | Recovery | Loop prevention |
| --- | --- | --- | --- |
| Next.js | `X-Deployment-ID` header (+ `?dpl=` query) | Hard navigation | URL-equality guard in `handleHardNavigation` |
| React Router v7 | `/__manifest?version=` endpoint | Document reload | sessionStorage flag |
| SvelteKit | `version.json` (reactive + optional poll) | Falls back to full-page nav | Full nav establishes new baseline |
| **rwsdk** | `X-Rwsdk-Build-Id` header + `/__rwsdk/version` endpoint | Full reload | sessionStorage `rwsdk:stale-asset-reload` |

## Observability for apps

Apps observe via the `rwsdk:stale-asset` window event, dispatched before each reload:

```ts
window.addEventListener("rwsdk:stale-asset", (event) => {
  const { reason } = (event as CustomEvent).detail;
  // reason: "build-id-mismatch" | "preload-error" | "version-poll-mismatch"
  Sentry.captureMessage("rwsdk stale-asset reload", {
    level: "info",
    tags: { reason },
  });
});
```

Useful for tracking deploy-boundary reload frequency in production telemetry without controlling the reload itself.
