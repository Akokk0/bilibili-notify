/**
 * 🔴 **一趟完整的协议往返 —— 可执行版的协议文档**(ADR-0012 决策 37)。
 *
 * 别的测试各自钉着一个零件:`server.test.ts` 只有端点、`adapter.test.ts` 塞的是假
 * `BridgeServer`、`blob.test.ts` 与 `blob-route.test.ts` 各拿着仓库的一半。**没有一条
 * 走完整条路**,而整条路上最容易断的恰恰是**两处独立构造的东西必须对得上**:
 *
 * - adapter 拿 `mountPath + "/blob" + id` 拼出一条 URL,
 * - 路由拿一个正则去认 `"/blob/<id>"`,
 * - 而地址那一头是**桥自己连进来时用的 Host**。
 *
 * 三者任意一处漂了,症状都是「消息到了但没有图」—— 平台拉图失败是静默的,日志上一个字
 * 都没有。所以这里的图**真的走一趟 HTTP**:桥收到 `send` 帧,拿帧里那条 URL 去 GET,
 * 比对字节。
 *
 * ⚠️ 宿主这一侧是**照着真宿主搭的替身**(拓展 import 不到 `apps/`,那条边不该有)。
 * 「真宿主真的这么接线」由 `apps/server/src/__tests__/bridge-e2e.test.ts` 与
 * `standalone-lifecycle.test.ts` 钉住,两边合起来才是完整的一根线。
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type {
	Connection,
	Disposable,
	ExtensionConnectionView,
	ExtensionContext,
	ExtensionFetchHandler,
	ExtensionUpgradeHandler,
	PlatformAdapter,
	PushExtensionDef,
	PushSourceHandle,
	PushTarget,
} from "@bilibili-notify/extension";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { WebSocket } from "ws";
import { activate } from "../index.js";

const EXTENSION_ID = "bridge";
const MOUNT_PREFIX = `/ext/${EXTENSION_ID}`;
const CONNECTION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TARGET_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TOKEN = "protocol-walk-token";
const BOT_ID = "bot-9";

/** 一张真图的字节 —— 内容随便,**要能逐字节比对**才证明得了取回来的就是存进去的那张。 */
const PNG = Buffer.from(
	"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100" +
		"05fe02fea7000000004945",
	"hex",
);

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

const CONNECTION: Connection = {
	id: CONNECTION_ID,
	name: "家里那台 koishi",
	enabled: true,
	kind: "extension",
	extensionId: EXTENSION_ID,
	config: { token: TOKEN, bridgeKind: "koishi" },
};

const TARGET: PushTarget = {
	id: TARGET_ID,
	name: "测试群",
	connectionId: CONNECTION_ID,
	kind: "session",
	platform: "telegram",
	scope: "group",
	address: "g-42",
	botId: BOT_ID,
	enabled: true,
};

/**
 * 宿主的替身 —— **只做真宿主做的那几件事**:分配挂载前缀并剥掉它、按前缀把 upgrade 交过来、
 * 把分发键按拓展 id 覆盖掉、代收 status 与 ctx 注册的一切。
 */
function hostFor(httpServer: HttpServer, connections: () => readonly Connection[]) {
	const timers: NodeJS.Timeout[] = [];
	const hooks: Array<() => void | Promise<void>> = [];
	let fetchHandler: ExtensionFetchHandler | undefined;
	let upgradeHandler: ExtensionUpgradeHandler | undefined;
	let adapter: PlatformAdapter | undefined;
	let statusOf: (() => unknown) | undefined;

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
		id: EXTENSION_ID,
		hostApiVersion: 1,
		hostVersion: "9.9.9-test",
		logger: SILENT,
		setTimeout: (fn, ms) => track(setTimeout(fn, ms)),
		setInterval: (fn, ms) => track(setInterval(fn, ms)),
		mount(handler) {
			fetchHandler = handler;
			return MOUNT_PREFIX;
		},
		registerPushSource<TConfig>(def: PushExtensionDef<TConfig>): PushSourceHandle<TConfig> {
			// 🔴 分发键由宿主按 id 填 —— 拓展自报的那份在这里被覆盖(决策 28)。
			adapter = { ...def.adapter, platforms: [EXTENSION_ID] };
			return {
				// 宿主拿**拓展自己那份 zod** 解 config,解不出的那条根本不交给它(决策 30)。
				connections: (): readonly ExtensionConnectionView<TConfig>[] =>
					connections().map((connection) => ({
						id: connection.id,
						name: connection.name,
						enabled: connection.enabled,
						config: def.configSchema.parse(connection.config),
					})),
				onConnectionsChanged: () => ({ dispose() {} }),
			};
		},
		inbound: { private() {}, group() {} },
		onUpgrade(handler) {
			upgradeHandler = handler;
		},
		publishStatus(fn) {
			statusOf = fn;
		},
		onDispose(fn) {
			hooks.push(fn);
		},
	};

	return {
		ctx,
		adapter: () => {
			if (!adapter) throw new Error("拓展没注册推送源");
			return adapter;
		},
		status: () => statusOf?.(),
		async dispose() {
			for (const fn of [...hooks].reverse()) await fn();
			for (const timer of timers) clearTimeout(timer);
		},
	};
}

type Frame = Record<string, unknown>;

/** 一个真插件:真 socket、真 `Authorization` 头、真 JSON 帧。 */
function peer(port: number, token: string) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}${MOUNT_PREFIX}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const frames: Frame[] = [];
	let waiter: ((frame: Frame) => void) | null = null;

	socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString("utf8")) as Frame;
		if (waiter) {
			const resolve = waiter;
			waiter = null;
			resolve(frame);
		} else frames.push(frame);
	});
	socket.on("error", () => {});

	return {
		open(): Promise<void> {
			return new Promise((resolve, reject) => {
				socket.once("open", () => resolve());
				socket.once("error", reject);
			});
		},
		send(frame: unknown): void {
			socket.send(JSON.stringify(frame));
		},
		next(): Promise<Frame> {
			const buffered = frames.shift();
			if (buffered) return Promise.resolve(buffered);
			return new Promise((resolve) => {
				waiter = resolve;
			});
		},
		dispose(): void {
			try {
				socket.terminate();
			} catch {
				// already gone
			}
		},
	};
}

describe("桥协议往返:hello → welcome → bots → send(带图)→ 真 GET 取图 → result", () => {
	let httpServer: HttpServer;
	let port: number;
	let host: ReturnType<typeof hostFor>;
	let client: ReturnType<typeof peer> | undefined;

	beforeEach(async () => {
		httpServer = createServer();
		host = hostFor(httpServer, () => [CONNECTION]);
		activate(host.ctx);
		await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
		port = (httpServer.address() as AddressInfo).port;
	});

	afterEach(async () => {
		client?.dispose();
		client = undefined;
		await host.dispose();
		await new Promise<void>((resolve) => httpServer.close(() => resolve()));
	});

	async function handshake(): Promise<void> {
		client = peer(port, TOKEN);
		await client.open();
		client.send({
			type: "hello",
			protocol: { major: 1, minor: 0 },
			bridge: { kind: "koishi", name: "家里那台 koishi", version: "0.1.0" },
			bots: [],
		});
		expect(await client.next()).toMatchObject({
			type: "welcome",
			protocol: { major: 1 },
			// 报的是**宿主**的版本号,不是拓展自己的 —— 插件据此提示「你这版 BN 太老了」。
			server: { version: "9.9.9-test" },
			inbound: { private: true, group: "with-links" },
		});
		client.send({
			type: "bots",
			bots: [{ botId: BOT_ID, platform: "telegram", name: "小电视" }],
		});
		// bots 是异步到达的,adapter 要在名单里找得到这个 bot 才发得出去。
		await expectEventually(() =>
			expect(host.adapter().isAvailable?.(CONNECTION, TARGET)).toBe(true),
		);
	}

	async function expectEventually(assertion: () => void): Promise<void> {
		let last: unknown;
		const deadline = Date.now() + 1_000;
		while (Date.now() < deadline) {
			try {
				assertion();
				return;
			} catch (err) {
				last = err;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		}
		throw last;
	}

	it("图片推送:帧里那条 URL 真的取得到,取回来的就是存进去的那张", async () => {
		await handshake();
		if (!client) throw new Error("unreachable");

		const delivered = host
			.adapter()
			.send(
				CONNECTION,
				TARGET,
				{ kind: "image", image: { buffer: PNG, mime: "image/png" }, caption: "看图" },
				{},
			);

		const frame = await client.next();
		expect(frame).toMatchObject({
			type: "send",
			botId: BOT_ID,
			platform: "telegram",
			target: { scope: "group", address: "g-42" },
			message: { kind: "image", mime: "image/png", caption: "看图" },
		});

		const url = (frame.message as { url: string }).url;
		// 🔴 地址是**这条桥自己连进来时用的那个** —— BN 猜不出别人从哪儿找得到它。
		const prefix = `http://127.0.0.1:${port}${MOUNT_PREFIX}/blob/`;
		expect(url.startsWith(prefix)).toBe(true);
		// id 本身就是凭据(128 位随机),所以它得真的是 128 位随机的样子。
		expect(url.slice(prefix.length)).toMatch(/^[0-9a-f]{32}$/);

		const got = await fetch(url);
		expect(got.status).toBe(200);
		expect(got.headers.get("content-type")).toBe("image/png");
		// 一次性的东西被谁缓存一份,取过即焚就等于没焚。
		expect(got.headers.get("cache-control")).toBe("no-store");
		expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);

		// 取过即焚:同一条 URL 再来一次就没了。
		expect((await fetch(url)).status).toBe(404);

		client.send({ type: "result", id: frame.id, ok: true });
		expect(await delivered).toMatchObject({ ok: true });
	});

	/**
	 * 面板要看的是**从配置那头看起**的名单 —— 最需要看见的恰恰是「配了但没连上」那条,
	 * 而它在会话表里根本不存在。
	 */
	it("publishStatus:握过手之后,面板拿得到会话与 bot 名单", async () => {
		await handshake();
		expect(host.status()).toEqual({
			sessions: [
				expect.objectContaining({
					connectionId: CONNECTION_ID,
					connected: true,
					kind: "koishi",
					name: "家里那台 koishi",
					version: "0.1.0",
					bots: [expect.objectContaining({ botId: BOT_ID, platform: "telegram" })],
				}),
			],
		});
	});
});
