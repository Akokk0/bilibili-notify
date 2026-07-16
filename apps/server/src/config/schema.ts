import { z } from "zod";

/**
 * Bootstrap config = the YAML/JSON file + ENV/CLI merge result that's read at startup.
 * Per plan §4.2. Runtime config (globals/subscriptions/targets) lives under `dataDir`
 * and is owned by ConfigStore — NOT mixed in here.
 */

const ServerSchema = z.object({
	host: z.string().min(1).default("0.0.0.0"),
	port: z.coerce.number().int().min(1).max(65535).default(8787),
});

const BasicAuthSchema = z.object({
	username: z.string().min(1),
	password: z.string().min(1),
});

const AuthSchema = z
	.object({
		basicAuth: BasicAuthSchema.optional(),
		/**
		 * Origin whitelist for WS upgrade requests. Empty/undefined disables the
		 * Origin gate (and the WS layer logs a warning at boot). Required for any
		 * deployment exposed beyond localhost — see plan §4.2 / Fix 4b.
		 */
		allowedOrigins: z.array(z.string().min(1)).optional(),
	})
	.optional();

/**
 * Optional preset push targets injected at first boot to save the user from doing it
 * manually in the dashboard. Stage 2.1 stores them as opaque records — full Zod typing
 * lives in `@bilibili-notify/internal/schema/targets`, but the loader stays decoupled
 * so that adding a new platform later doesn't force a config-schema bump here.
 */
const PresetPushTargetSchema = z
	.object({
		name: z.string().min(1),
		platform: z.string().min(1),
		scope: z.enum(["group", "private", "channel"]).optional(),
		config: z.record(z.string(), z.unknown()).default({}),
	})
	.passthrough();

const PresetSchema = z
	.object({
		pushTargets: z.array(PresetPushTargetSchema).default([]),
	})
	.optional();

export const BootstrapConfigSchema = z.object({
	server: ServerSchema.default({ host: "0.0.0.0", port: 8787 }),
	dataDir: z.string().min(1).default("./data"),
	/**
	 * Passphrase for the AES-256-GCM at-rest secrets path (plan §4.1). When set
	 * (env fallback `BN_COOKIE_KEY`), `createKeyProvider` scrypt-derives the key
	 * and never writes it to disk — cookie + AI apiKey share that one key/salt.
	 * When unset, StorageManager falls back to the co-located random
	 * `<dataDir>/secrets/master.key` (obfuscation only; boot logs a prominent warn).
	 */
	cookieEncryptionKey: z.string().min(1).optional(),
	/**
	 * Absolute path to a Chromium / Chrome binary. Required for
	 * /api/cards/preview (puppeteer-core does NOT bundle a browser) unless
	 * `chromeEndpoint` points at a remote one. Without either, the cards route
	 * reports 503 and the dashboard renders a config hint.
	 */
	chromePath: z.string().min(1).optional(),
	/**
	 * Remote browser endpoint (env `BN_CHROME_ENDPOINT`). `ws://…` connects
	 * straight to a DevTools websocket (browserless etc.); `http://…` is a
	 * `--remote-debugging-port` HTTP endpoint puppeteer resolves itself.
	 * Wins over `chromePath`. This is how the chromium-less `-slim` Docker
	 * image gets card rendering — point it at a companion browser container.
	 */
	chromeEndpoint: z.string().min(1).optional(),
	/**
	 * Seconds of render inactivity before the browser is auto-closed
	 * (local launch) or disconnected (remote endpoint) to free memory; the
	 * next render lazily restarts it. `0` = keep it alive forever. Unset =
	 * adapter default (300s).
	 */
	chromeIdleSeconds: z.coerce.number().int().min(0).optional(),
	/**
	 * Directory holding the built React dashboard (`web/dist`). When set, the
	 * Hono app mounts a static file server for non-`/api/*` paths and falls
	 * back to `index.html` for SPA routes. When unset, the server is API-only
	 * (dev mode uses `vite` separately on port 5173). Docker images set this
	 * to `/app/web-dist` via `BN_WEB_DIST`.
	 */
	webDistDir: z.string().min(1).optional(),
	auth: AuthSchema,
	logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
	preset: PresetSchema,
});

export type BootstrapConfig = z.infer<typeof BootstrapConfigSchema>;
