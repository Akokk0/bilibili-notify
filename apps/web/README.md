# Bilibili-Notify Dashboard

React 18 + Vite+ + Tailwind 4 + TanStack Query + Zustand + React Router 7. A workspace member alongside `apps/server` and the business-core `packages/*`. Use the repository's vp toolchain. The dashboard talks to Hono through `/api/*` (REST) and `/ws` (WebSocket subscriptions).

## Quick start

```bash
# from the repo root
vp install
vp run dev:apps    # backend on :8787, then frontend on :5173
# Or run the processes separately:
vp run dev:server
vp run dev:web
```

Vite dev server proxies `/api` and `/ws` to `127.0.0.1:8787`, so you load `http://localhost:5173` and the network panel still shows clean same-origin requests. Backend stays a separate process — restart it independently.

## Layout

```
src/
  main.tsx          ← React + Router + QueryClient bootstrap
  App.tsx           ← authenticated shell, providers, and route table
  styles.css        ← shared UI theme and Tailwind entry
  pages/            ← dashboard, subscriptions, targets, history, statistics,
                       rules, cards, resource library, AI, extensions, system,
                       logs, and About
    guide/content/  ← embedded getting-started guides in four languages
  components/       ← components that depend on application data and services
  i18n/             ← locale and voice subscriptions
  services/
    api.ts          ← fetch wrapper for REST
    ws.ts           ← WebSocket subscription client
```

Reusable presentation components and design tokens live in `packages/ui`; application components consume them through `@bilibili-notify/ui`. Subscription pages use source descriptors for search hints, display accounts, labels, and supported features. Getting-started content follows the panel locale; historical release notes retain their original text.

Production builds use `vp run -F @bilibili-notify/web build`; `vp run -F @bilibili-notify/web typecheck` checks types. See [deployment and configuration](../README.md) for running BN and [the repository guide](../../CLAUDE.md) for development conventions.
