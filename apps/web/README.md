# Bilibili-Notify Dashboard

React, Vite+, Tailwind CSS, TanStack Query, Zustand, and React Router. Use the workspace versions in `pnpm-workspace.yaml` and the repository's vp toolchain. The dashboard talks to the Hono host through `/api/*` (REST) and `/ws` (WebSocket subscriptions).

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
  pages/            ← page routes, including subscriptions, targets, statistics,
                       cards, AI, extensions, system settings, and About
    guide/content/  ← Markdown guides embedded in About in four languages
  components/       ← components that depend on application data and services
  i18n/             ← locale and voice subscriptions
  services/
    api.ts          ← fetch wrapper for REST
    ws.ts           ← WebSocket subscription client
```

Reusable presentation components and design tokens live in `packages/ui`; application components consume them through `@bilibili-notify/ui`. Subscription pages use source descriptors for search hints, display accounts, labels, and supported features. Getting-started content follows the panel locale; historical release notes retain their original text.

Build the dashboard with `vp run -F @bilibili-notify/web build`. Open a clean checkout with `vp run gate` to build workspace dependencies, type-check, and run the test suite. [Deployment and configuration](../README.md) · [Repository guide](../../CLAUDE.md)
