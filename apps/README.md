# Bilibili-Notify Dashboard

Hono HTTP server + React dashboard. The Koishi sub-plugins under `koishi/` remain the historical shipping form; this directory is the primary product form going forward (per `/Users/akokko/.claude/plans/hashed-jingling-moth.md`).

## Layout

```
apps/
  pnpm-workspace.yaml        # this is its OWN pnpm workspace, invisible to the root yarn workspace
  package.json               # @bilibili-notify/root (private)
  server/                    # Hono + Node 20 backend
  web/                       # React + Vite dashboard
  Dockerfile                 # multi-stage; build context = repo root
  docker-compose.example.yaml
```

The root yarn workspace at `../` only owns `packages/*` and `koishi/*`. This `apps/` subtree is intentionally invisible to it; pnpm handles install / build here. Business cores from `packages/` are consumed via pnpm `link:` protocol so edits in `packages/internal/src` show up immediately.

## Quick start (dev)

```bash
cd apps
pnpm install                 # uses pnpm via corepack (packageManager pinned)
pnpm typecheck
pnpm dev                     # tsx watch on server/src/index.ts + vite on web/
curl -s http://localhost:8787/api/health
```

`pnpm build` produces `server/lib/` + `web/dist/`. `pnpm start` runs the built server. Press Ctrl+C for graceful shutdown.

## Configuration

Bootstrap config order (per plan §4.2):

1. CLI args
2. ENV (`BN_*`)
3. `./bn.config.{yaml,json}` next to cwd (or `BN_CONFIG=path/to/file`)
4. Defaults

Required keys: `server.{host,port}`, `dataDir`. `cookieEncryptionKey` falls back to `BN_COOKIE_KEY`. See `server/src/config/schema.ts` for the full Zod schema. Track changes against `server/bn.config.example.yaml`; copy to `bn.config.yaml` (gitignored) and edit for your machine.

## Docker deployment

The image bundles the built React dashboard at `/app/web-dist`; the Hono server serves it for any non-`/api/*` path, so a single container is enough — no nginx needed.

```bash
# From the repo root (build context must be the parent of apps/):
docker build -f apps/Dockerfile -t bilibili-notify:dev .

# Or pull the prebuilt image (CI publishes from refactor + main):
docker pull ghcr.io/<owner>/bilibili-notify:latest

docker run -d \
  --name bilibili-notify \
  -p 8787:8787 \
  -v "$(pwd)/data:/data" \
  -v "$(pwd)/bn.config.yaml:/app/apps/server/bn.config.yaml:ro" \
  -e BN_DASHBOARD_USER=admin \
  -e BN_DASHBOARD_PASS='change-me' \
  bilibili-notify:dev
```

`docker-compose.example.yaml` ships a copy-paste starter, including a commented NapCat sidecar block for OneBot v11 → QQ delivery on the same docker network.

### Image-baked defaults (override via env or yaml)

| Env var | Default in image | Purpose |
|---|---|---|
| `BN_HOST` | `0.0.0.0` | bind address |
| `BN_PORT` | `8787` | http port |
| `BN_DATA_DIR` | `/data` | runtime state — declared as a volume |
| `BN_CHROME_PATH` | `/usr/bin/chromium` | apt-installed chromium for puppeteer-core preview |
| `BN_WEB_DIST` | `/app/web-dist` | built dashboard served by Hono at `/` |
| `BN_LOG_LEVEL` | (unset → `info`) | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent` |
| `BN_DASHBOARD_USER` / `BN_DASHBOARD_PASS` | (unset → no auth, warn) | basic-auth for `/api/*` |
| `BN_COOKIE_KEY` | (unset → auto-generated under `/data/secrets`) | bilibili cookie encryption key |
| `BN_CONFIG` | (unset) | absolute or cwd-relative path to the bootstrap yaml/json |

### Volume layout

```
/data
├── secrets/
│   └── master.key                # auto-generated AES key (per-deployment)
├── state/
│   ├── globals.json              # GlobalConfig — written by the dashboard
│   ├── subscriptions.json        # Subscription[]
│   └── targets.json              # PushTarget[]
└── history/
    ├── 2026-05-09.jsonl          # daily push log
    └── img/                      # attached card pngs
```

The image declares `/data` as a Docker volume — bind-mount it to a host directory you back up, otherwise state evaporates with the container.

### Wiring OneBot (NapCat)

1. Bring up the napcat sidecar (uncomment the block in `docker-compose.example.yaml`) and configure your QQ account through its WebUI on `http://<host>:6099`.
2. In the bilibili-notify dashboard, open **推送目标** → **新建** → platform `onebot`, baseUrl `http://napcat:3000` (intra-docker hostname), set `accessToken` if you set one in NapCat, and pick `scope=group` + the target group id.
3. Hit **测试** to verify the OneBot endpoint replies, then save. The new target is now selectable on per-UP routing.

## Where the Koishi end lives

`../koishi/core` (and the 5 sub-plugin packages alongside). Same business cores power both ends.

## Plan reference

`/Users/akokko/.claude/plans/hashed-jingling-moth.md`. Stages 0–4 land on the `refactor` branch; npm releases come from `main`.
