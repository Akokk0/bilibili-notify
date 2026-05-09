# Bilibili-Notify Dashboard

React 18 + Vite + Tailwind 4 + TanStack Query + Zustand + React Router 7. Lives inside the `apps/` pnpm sub-workspace alongside `server/`. Talks to the Hono backend through `/api/*` (REST) and `/ws` (WebSocket subscriptions).

## Quick start

```bash
# from apps/
pnpm install                 # picks up server/ + web/ together
pnpm --filter @bilibili-notify/server dev    # backend on :8787
pnpm --filter @bilibili-notify/web dev       # frontend on :5173
```

Vite dev server proxies `/api` and `/ws` to `127.0.0.1:8787`, so you load `http://localhost:5173` and the network panel still shows clean same-origin requests. Backend stays a separate process — restart it independently.

## Layout

```
src/
  main.tsx          ← React + Router + QueryClient bootstrap
  App.tsx           ← top-level layout + route table (placeholder pages for now)
  styles.css        ← @import "tailwindcss";
  services/
    api.ts          ← fetch wrapper for REST
    ws.ts           ← WebSocket subscription client
```

Pages will land under `src/pages/*` as stage 3 progresses (Auth / Subs / Targets / Rules / Cards / AI / Dashboard / History).
