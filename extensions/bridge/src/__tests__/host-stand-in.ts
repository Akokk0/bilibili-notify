/**
 * 宿主的替身 —— 桥的测试共用:`e2e.test.ts` 走协议往返、`devtools-*.test.ts` 跑假桥与场景。
 *
 * ⚠️ 拓展 import 不到 `apps/`(那条边不该有),所以宿主这一侧是**照着真宿主搭的替身**,
 * 只做真宿主做的那几件事(见 {@link hostFor})。
 */

import type { Server as HttpServer } from "node:http";
import type {
	Connection,
	Disposable,
	ExtensionContext,
	ExtensionDevtoolsContext,
	ExtensionFetchHandler,
	ExtensionI18n,
	ExtensionItemView,
	ExtensionTableCell,
	ExtensionUpgradeHandler,
	ExtensionView,
	HttpClient,
	PlatformAdapter,
	PlatformAdapterDef,
	PlatformAdapterHandle,
	PushTarget,
} from "@bilibili-notify/extension";
import { fail, ok } from "@bilibili-notify/extension";
import { WebSocket } from "ws";
import { CHINESE } from "./bridge-texts.js";
import { memoryKeyValueStore } from "./memory-key-value-store.js";

const EXTENSION_ID = "bridge";
export const MOUNT_PREFIX = `/ext/${EXTENSION_ID}`;
/** 视图里这条接入的那一项。 */
export function itemView(status: unknown): ExtensionItemView | undefined {
	return (status as ExtensionView | undefined)?.items?.links?.[LINK_ID];
}

/** 这条接入那张 bot 表的每一行。 */
export function botRows(status: unknown): readonly (readonly ExtensionTableCell[])[] {
	const table = itemView(status)?.blocks?.find((block) => block.type === "table");
	return table?.type === "table" ? table.rows : [];
}

export const LINK_ID = "link-home";
export const CONNECTION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TARGET_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const TOKEN = "protocol-walk-token";
export const BOT_ID = "bot-9";
/** 桥随 bot 报上来的平台图标 —— 面板拿它画 bot 行左边那枚方块。 */
export const BOT_ICON = `data:image/png;base64,${"A".repeat(32)}`;

export const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

/** 一条接入 —— 住设置里(`ctx.settings`),插件拿它的 token 连上来。 */
export const SETTINGS = {
	links: [
		{ id: LINK_ID, name: "家里那台 koishi", enabled: true, token: TOKEN, bridgeKind: "koishi" },
	],
};

/** 设置「此刻读不懂」的替身值:假宿主的 `get()` 见到它回 `invalid`(真宿主是跑着时被旁路写坏的那一拍)。 */
export const UNREADABLE = Symbol("unreadable");

/** 一条连接 = 那条接入上的一个 bot(ADR-0012 决策 45)。 */
export const CONNECTION: Connection = {
	id: CONNECTION_ID,
	name: "电报那个 bot",
	enabled: true,
	adapterKey: EXTENSION_ID,
	platform: "telegram",
	settings: { link: LINK_ID, botId: BOT_ID },
	platformSnapshot: {
		label: "telegram",
		shortLabel: "telegram",
		color: "#94a3b8",
		targetKind: "session",
		scopes: ["group", "private", "channel"],
		addressNouns: {},
	},
};

export const TARGET: PushTarget = {
	id: TARGET_ID,
	name: "测试群",
	connectionId: CONNECTION_ID,
	kind: "session",
	scope: "group",
	address: "g-42",
	enabled: true,
};

/**
 * 宿主的替身 —— **只做真宿主做的那几件事**:分配挂载前缀并剥掉它、按前缀把 upgrade 交过来、
 * 把分发键按拓展 id 覆盖掉、代收 status 与 ctx 注册的一切。
 */
export function hostFor(
	httpServer: HttpServer,
	connections: () => readonly Connection[],
	settings: () => unknown,
	options: { http?: HttpClient; signal?: AbortSignal; i18n?: ExtensionI18n } = {},
) {
	const timers: NodeJS.Timeout[] = [];
	const hooks: Array<() => void | Promise<void>> = [];
	/** 订了「设置动了」的那些 —— 桥拿它接对账与面板刷新。 */
	const settingsListeners = new Set<() => void>();
	let fetchHandler: ExtensionFetchHandler | undefined;
	let upgradeHandler: ExtensionUpgradeHandler | undefined;
	let adapter: PlatformAdapter | undefined;
	let statusOf: (() => unknown) | undefined;
	let statusChanges = 0;
	/** 喂回核心的入站消息 —— 「该不该收」那道闸只在这儿看得出来。 */
	const inboundCalls: { route: "private" | "group"; msg: unknown; meta: unknown }[] = [];

	function track(timer: NodeJS.Timeout): Disposable {
		timers.push(timer);
		return { dispose: () => clearTimeout(timer) };
	}

	httpServer.on("request", (req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
			if (!fetchHandler || !url.pathname.startsWith(MOUNT_PREFIX)) {
				res.writeHead(404).end();
				return;
			}
			// 前缀在宿主这一层剥掉:拓展注册的是 `/blob/:id`,它从不写 `/ext/bridge`。
			url.pathname = url.pathname.slice(MOUNT_PREFIX.length) || "/";
			const response = await fetchHandler(new Request(url, { method: req.method }));
			res.writeHead(response.status, Object.fromEntries(response.headers));
			res.end(Buffer.from(await response.arrayBuffer()));
		})();
	});
	httpServer.on("upgrade", (req, socket, head) => {
		const path = (req.url ?? "").split("?")[0]?.slice(MOUNT_PREFIX.length) || "/";
		upgradeHandler?.({ req, socket, head, path });
	});

	const ctx: ExtensionContext = {
		timezone: () => "Asia/Shanghai",
		onTimezoneChanged: () => ({ dispose() {} }),
		id: EXTENSION_ID,
		hostApiVersion: 1,
		hostVersion: "9.9.9-test",
		logger: SILENT,
		i18n: options.i18n ?? CHINESE,
		state: memoryKeyValueStore(),
		secrets: memoryKeyValueStore(),
		signal: options.signal ?? new AbortController().signal,
		redact() {},
		reportProblem() {},
		resolveProblem() {},
		http: options.http ?? {
			fetch: async () => fail("unavailable", "桥的测试不联网"),
			websocket: () => fail("unavailable", "桥的测试不联网"),
		},
		fetchImage: async () => fail("unavailable", "桥的测试不联网"),
		storeImage: async () => fail("unavailable", "桥的测试不联网"),
		setTimeout: (fn, ms) => track(setTimeout(fn, ms)),
		setInterval: (fn, ms) => track(setInterval(fn, ms)),
		mount(handler) {
			fetchHandler = handler;
			return MOUNT_PREFIX;
		},
		registerPlatformAdapter(def: PlatformAdapterDef): PlatformAdapterHandle {
			// 🔴 分发键由宿主按 id 填 —— 拓展自报的那份在这里被覆盖(决策 28)。描述真宿主照清单填,
			// 桥的测试不读它,替身给一份占位。
			adapter = {
				...def,
				adapterKey: EXTENSION_ID,
				descriptor: () => ({ label: "桥", shortLabel: "桥", color: "#000000", settingsFields: [] }),
			};
			// 登记即 `start`:适配器上下文里的 `inbound` 是桥交入站的唯一出口。替身不核归属、不补平台,
			// 原样记下桥交来的东西(含 meta —— 桥只该报 `connectionId`)。
			adapter.start({
				timezone: ctx.timezone,
				onTimezoneChanged: ctx.onTimezoneChanged,
				logger: SILENT,
				signal: ctx.signal,
				onDispose: (fn) => ctx.onDispose(fn),
				state: ctx.state,
				secrets: ctx.secrets,
				redact() {},
				// 与真宿主一样转发集成上下文那一份(同一个实现)。
				settings: (schema) => ctx.settings(schema),
				http: ctx.http,
				fetchImage: ctx.fetchImage,
				storeImage: ctx.storeImage,
				reportProblem() {},
				resolveProblem() {},
				connections: () =>
					connections().flatMap((connection) => {
						if (connection.adapterKey !== EXTENSION_ID) return [];
						const parsed = def.settingsSchema.safeParse(connection.settings);
						return parsed.success ? [{ ...connection, settings: parsed.data }] : [];
					}),
				onConnectionsChanged: () => ({ dispose() {} }),
				inbound: {
					private: (msg, meta) => inboundCalls.push({ route: "private", msg, meta }),
					group: (msg, meta) => inboundCalls.push({ route: "group", msg, meta }),
				},
			});
			return { dispose() {} };
		},
		registerSource() {
			throw new Error("桥的清单没开 contributes.subscription,不该注册订阅源");
		},
		onUpgrade(handler) {
			upgradeHandler = handler;
		},
		publishView(fn) {
			statusOf = fn;
		},
		statusChanged() {
			statusChanges += 1;
		},
		// 设置也按真宿主的做法:拿拓展交的那份 zod 解、交回 `Result`;动了由 `settingsChanged()` 扇出。
		settings: (schema) => ({
			get: () => {
				const raw = settings();
				if (raw === UNREADABLE) return fail("invalid", "存着的设置读不懂");
				return ok({ settings: schema.parse(raw) });
			},
			onChange: (fn) => {
				settingsListeners.add(fn);
				return { dispose: () => settingsListeners.delete(fn) };
			},
		}),
		// 桥不接动作(它的清单没有 actions)。
		onAction() {},
		onDispose(fn) {
			hooks.push(fn);
		},
	};

	return {
		ctx,
		adapter: () => {
			if (!adapter) throw new Error("拓展没注册平台适配器");
			return adapter;
		},
		status: () => statusOf?.(),
		statusChanges: () => statusChanges,
		inbound: () => inboundCalls,
		/** 主人在面板上存了一次设置 —— 真宿主是 globals 落盘之后扇出给每个订阅者。 */
		settingsChanged(): void {
			for (const fn of [...settingsListeners]) fn();
		},
		async dispose() {
			for (const fn of [...hooks].reverse()) await fn();
			for (const timer of timers) clearTimeout(timer);
		},
	};
}

/**
 * 真的 `ws` 与 `fetch` 套成的 `ctx.http` —— 假桥的测试要真的连到桥自己的端点上。
 * 形状照真宿主的 `HttpClient`:`signal` 中止就关连接;`fetch` 非 2xx 不抛,网络断回结果形状。
 */
export function realHttp(): HttpClient {
	return {
		async fetch(url, init) {
			try {
				const res = await fetch(url, { signal: init?.signal });
				const body = new Uint8Array(await res.arrayBuffer());
				return ok({
					url: res.url,
					status: res.status,
					headers: res.headers,
					body,
					isSuccess: res.ok,
					text: () => new TextDecoder().decode(body),
					json: () => fail("invalid", "测试替身不解析 JSON"),
				});
			} catch (err) {
				return fail("unavailable", (err as Error).message);
			}
		},
		websocket(url, init) {
			// 给错地址回 `invalid`,不抛(真 `HttpClient` 的契约)。
			try {
				const socket = new WebSocket(String(url), { headers: init?.headers });
				init?.signal?.addEventListener("abort", () => socket.close(), { once: true });
				return ok({ socket: socket as never });
			} catch (err) {
				return fail("invalid", (err as Error).message);
			}
		},
	};
}

/** 开发入口拿到的上下文:`activate` 那份加 `mountUrl()`。 */
export function devtoolsContextOf(
	ctx: ExtensionContext,
	mountUrl: () => string | undefined,
): ExtensionDevtoolsContext {
	return { ...ctx, mountUrl };
}

/**
 * 在 `ctx.http` 外再包一层记账:假桥**发出去的帧**原样记下,另留一个往里塞帧的口
 * (模拟「BN 发来一种没见过的帧」)。其余原样走 `base`。
 */
export function recordingHttp(base: HttpClient = realHttp()): {
	http: HttpClient;
	sent: Record<string, unknown>[];
	inject(frame: unknown): void;
} {
	const sent: Record<string, unknown>[] = [];
	const listeners: ((...args: unknown[]) => void)[] = [];
	return {
		sent,
		inject(frame) {
			for (const fn of listeners) fn(Buffer.from(JSON.stringify(frame)));
		},
		http: {
			fetch: (url, init) => base.fetch(url, init),
			websocket(url, init) {
				const made = base.websocket(url, init);
				if (!made.ok) return made;
				const socket = made.socket;
				return ok({
					socket: {
						get binaryType() {
							return socket.binaryType;
						},
						set binaryType(value: string) {
							socket.binaryType = value;
						},
						get readyState() {
							return socket.readyState;
						},
						on(event: string, listener: (...args: unknown[]) => void) {
							if (event === "message") listeners.push(listener);
							socket.on(event, listener);
						},
						send(data: string | Uint8Array) {
							if (typeof data === "string") sent.push(JSON.parse(data) as Record<string, unknown>);
							socket.send(data);
						},
						close: () => socket.close(),
					},
				});
			},
		},
	};
}
