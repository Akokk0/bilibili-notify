/**
 * 🔴 **一条真桥带着真 token 连进来,收下一条真推送并回执** —— 装配那一整根线(ADR-0012
 * 决策 37)。
 *
 * 别处的测试全是在各自搭的零件上跑的:端点自己起一台 http server、adapter 自己塞一个假
 * `BridgeServer`、装载器自己种一个假拓展。**没有任何一条**把它们串起来过,而桥搬成拓展
 * 动的正是串起来的每一根线:
 *
 * ```
 * connections.json 里那条接入 → 宿主按 zod 解出 config → ctx 交给桥 → 桥认 token
 *   → upgrade 分发到桥 → 握手 → bot 名单 → publishStatus
 * /api/push/test → sink 按**分发键**找 adapter(键 = 拓展 id)→ 桥 adapter
 *   → server.send → `send` 帧 → 桥回 `result` → 回执一路回到 HTTP 响应
 * ```
 *
 * 断哪一环,症状都是「插件连得上但推送不来」或者「面板上一直转圈」,而**四道门禁全绿**。
 *
 * ⚠️ **这里刻意不验取图 URL**:真实的图片推送要么来自卡片渲染(要 puppeteer),要么来自
 * 扫码登录(要 B 站网络),两条在测试环境里都走不通。取图那一整段(adapter 拼出来的 URL
 * ↔ 路由认得的路径)由 `extensions/bridge/src/__tests__/e2e.test.ts` 拿真 HTTP GET 钉住。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { WebSocket } from "ws";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";
import { installBridgeInto } from "./support/install-bridge.js";

const CONNECTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/** 主人在面板上生成的那条长期 token —— 桥握手时拿它换身份。 */
const TOKEN = "e2e-bridge-token-0123456789";
const BOT_ID = "bot-1";
const GROUP_ADDRESS = "g-42";

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (!address || typeof address === "string") {
				probe.close(() => reject(new Error("failed to allocate test port")));
				return;
			}
			const { port } = address;
			probe.close(() => resolve(port));
		});
	});
}

type Frame = Record<string, unknown>;

/**
 * 一个**真插件**该有的样子 —— 真 socket、真 `Authorization` 头、真 JSON 帧。
 *
 * 帧收进队列而不是逐条断言:协议是异步的,`send` 帧什么时候到取决于推送链路,
 * 拿一个「下一帧」的 promise 才写得出线性的剧本。
 */
function peer(port: number, token: string) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ext/bridge`, {
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
	// upgrade 被拒时 ws 会 emit error;不接住会变成 unhandled rejection。
	socket.on("error", () => {});
	let closeCode: number | undefined;
	socket.on("close", (code) => {
		closeCode = code;
	});

	return {
		open(): Promise<void> {
			if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
			return new Promise((resolve, reject) => {
				socket.once("open", () => resolve());
				socket.once("error", reject);
				socket.once("unexpected-response", (_req, res) =>
					reject(new Error(`upgrade 被拒:HTTP ${res.statusCode}`)),
				);
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
		/** 等 BN 把这条连接断掉,回它给的 close code。 */
		closed(): Promise<number> {
			if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(closeCode ?? 1006);
			return new Promise((resolve) => {
				socket.once("close", (code: number) => resolve(code));
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

type Peer = ReturnType<typeof peer>;

function helloFrame() {
	return {
		type: "hello",
		protocol: { major: 1, minor: 0 },
		bridge: { kind: "koishi", name: "家里那台 koishi", version: "0.1.0" },
		// 名单**故意留空**:下面那帧 `bots` 才是把 bot 交出来的那一步,空着才证明得了
		// 「快照帧真的被收下了」——hello 里就带上的话,这条断言两条路都会绿。
		bots: [],
	};
}

function botsFrame() {
	return {
		type: "bots",
		bots: [
			{
				botId: BOT_ID,
				platform: "telegram",
				name: "小电视",
				selfId: "10086",
				capabilities: { atAll: "supported", inbound: "supported" },
			},
		],
	};
}

describe("桥拓展 e2e:真客户端 → 真推送 → 真回执", () => {
	let dataDir: string;
	let handle: StandaloneServerHandle | undefined;
	let port: number;
	let client: Peer | undefined;

	/**
	 * 摆一份**主人已经配好**的数据目录:桥拓展开着、一条接入(带 token)、一个挂在它
	 * 名下的群目标。
	 *
	 * globals 先跑一趟空启动再改,而不是手写一份 —— `GlobalConfigSchema` 的 `app` /
	 * `master` / `defaults` 都没有默认值,手写一份缺格的会在开机 parse 时整份被判废。
	 */
	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-bridge-e2e-"));
		const seed = await boot(await findFreePort());
		await seed.close("seed");

		const globalsPath = join(dataDir, "state", "globals.json");
		const globals = JSON.parse(await readFile(globalsPath, "utf8")) as Record<string, unknown>;
		globals.extensions = { bridge: { enabled: true } };
		// 拓展是**装进来的**(本体一个都不带,仓里那个目录也不再是根)—— 这一下就是
		// 开发版 devtools / 日后插件市场做的那件事:把包摆进唯一那个装载根。
		await installBridgeInto(dataDir);
		await writeFile(globalsPath, JSON.stringify(globals));

		await writeFile(
			join(dataDir, "state", "connections.json"),
			JSON.stringify([
				{
					id: CONNECTION_ID,
					name: "家里那台 koishi",
					enabled: true,
					kind: "extension",
					extensionId: "bridge",
					config: { token: TOKEN, bridgeKind: "koishi" },
				},
			]),
		);
		await writeFile(
			join(dataDir, "state", "targets.json"),
			JSON.stringify([
				{
					id: TARGET_ID,
					name: "测试群",
					connectionId: CONNECTION_ID,
					kind: "session",
					// 桥后面挂着什么平台是**运行时**才知道的,目标那一格是开放词表。
					platform: "telegram",
					scope: "group",
					address: GROUP_ADDRESS,
					// 一条桥连接后面可能挂着好几个 bot,所以目标要记是哪一个。
					botId: BOT_ID,
					enabled: true,
				},
			]),
		);
	});

	afterAll(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	function boot(at: number): Promise<StandaloneServerHandle> {
		return startStandaloneServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(at),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
			shutdownTimeoutMs: 1_000,
		});
	}

	beforeEach(async () => {
		port = await findFreePort();
		handle = await boot(port);
	});

	afterEach(async () => {
		client?.dispose();
		client = undefined;
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
	});

	/**
	 * 握到手、把 bot 名单交上去,并等到宿主那一侧真的看见了它。
	 *
	 * 等状态口而不是 `sleep`:推送链路在目标不可达时会**退避重试 3 秒起步**,抢在名单
	 * 到达前发出去的话这条测试要么慢三秒、要么偶发红,而两种都不是被测行为。
	 */
	async function handshake(): Promise<void> {
		client = peer(port, TOKEN);
		await client.open();
		client.send(helloFrame());

		const welcome = await client.next();
		expect(welcome).toMatchObject({
			type: "welcome",
			protocol: { major: 1 },
			// 群消息恒要含链接的那些(链接解析在本地判),私聊要,这是订阅的出厂形状。
			inbound: { private: true, group: "with-links" },
		});
		expect(typeof (welcome.server as { version?: unknown } | undefined)?.version).toBe("string");

		client.send(botsFrame());
		await expectStatusEventually((status) => {
			expect(status.sessions).toEqual([
				expect.objectContaining({
					connectionId: CONNECTION_ID,
					connected: true,
					kind: "koishi",
					name: "家里那台 koishi",
					version: "0.1.0",
					bots: [
						expect.objectContaining({
							botId: BOT_ID,
							platform: "telegram",
							// 桥少报的能力补成 `unknown`,不是 `false` —— 「不支持」与「还不知道」
							// 在面板上是两回事。
							capabilities: {
								atAll: "supported",
								inbound: "supported",
								forward: "unknown",
								miniAppCard: "unknown",
								shareCardLinks: "unknown",
								// 桥没报 markdown → 补成 unknown。BN 据此把主人写的排版剥成纯文本。
								markdown: "unknown",
							},
						}),
					],
				}),
			]);
		});
	}

	interface BridgeStatus {
		sessions: Record<string, unknown>[];
	}

	async function expectStatusEventually(assertion: (status: BridgeStatus) => void): Promise<void> {
		let last: unknown;
		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline) {
			const res = await fetch(`${handle?.url}/api/ext/bridge/status`);
			const status = (await res.json()) as BridgeStatus;
			try {
				assertion(status);
				return;
			} catch (err) {
				last = err;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
		throw last;
	}

	function testPush(): Promise<Response> {
		return fetch(`${handle?.url}/api/push/test`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ targetId: TARGET_ID, kind: "text" }),
		});
	}

	it("hello → welcome → bots → 一条真推送变成 send 帧 → result 回到 HTTP 响应", async () => {
		await handshake();
		if (!client) throw new Error("unreachable");

		// **先发起再等帧**:HTTP 那一发要等桥回执才会返回,先 await 它就死锁了。
		const pushed = testPush();
		const frame = await client.next();
		expect(frame).toMatchObject({
			type: "send",
			botId: BOT_ID,
			// 平台跟着**目标**走,不是跟着连接走 —— 桥接入根本没有 platform 那一格。
			platform: "telegram",
			target: { scope: "group", address: GROUP_ADDRESS },
			message: { kind: "text", text: expect.stringContaining("测试推送") },
		});
		expect(typeof frame.id).toBe("string");

		client.send({ type: "result", id: frame.id, ok: true });
		const res = await pushed;
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true });
	});

	/**
	 * 失败那一路要**同样通到底**:桥说的那句话得原样回到面板上。
	 *
	 * 只验成功的话,「回执里的 err 被吞掉」这种缺陷永远不会红 —— 而那正是用户最需要看见
	 * 的一句(平台的拒绝理由),吞掉之后面板上只剩一个红叉。
	 */
	it("桥回 ok:false 时,它给的理由原样出现在推送结果里", async () => {
		await handshake();
		if (!client) throw new Error("unreachable");

		const pushed = testPush();
		const frame = await client.next();
		client.send({ type: "result", id: frame.id, ok: false, err: "telegram 说这个群不存在" });

		expect(await (await pushed).json()).toMatchObject({
			ok: false,
			err: "telegram 说这个群不存在",
		});
	});

	/**
	 * 🔴 **拨开关即热装卸**(ADR-0012 决策 10),整条线走一遍:
	 * `PATCH /api/globals` → 落盘 → `config-changed` → 装载器 `sync()` → 拓展被收回。
	 *
	 * 零件各自的单元测试证明不了这一根线接上了没有:`sync()` 自己有测试,总线也有,
	 * 而**谁去订这个事件、订的是哪个 scope** 只有从这一头推到那一头才看得见。
	 *
	 * 断开那一下要**看得见**:配置全留、代码没了,插件收到的是可以退避重连的那种断连,
	 * 而不是「BN 还在,但它永远不理我了」。
	 */
	it("关掉拓展 → 活着的桥当场掉线、端点也没了;拨回来又能连上", async () => {
		await handshake();
		if (!client) throw new Error("unreachable");
		const wentAway = client.closed();

		expect((await setBridgeEnabled(false)).status).toBe(200);

		// ① 活着的那条当场断开 —— 不用等它自己发现。
		expect(await wentAway).toBeGreaterThan(0);
		// ② 端点也跟着摘了:再连过来是宿主的 404(没人认领),不是桥的 401 / 503。
		await expect(peerOnce()).rejects.toThrow("HTTP 404");

		// ③ 拨回来:同一个进程里 activate 又跑一遍,一切照旧。
		expect((await setBridgeEnabled(true)).status).toBe(200);
		// 🔴 `PATCH /api/globals` **在热装卸落地之前就回 200**(启用那一路要真 import 一个
		// 文件)。面板靠 `GET /api/ext` 先 settle 再报状态,这里也走同一条 —— 不等的话
		// 这一发 upgrade 有时会撞在「端点还没挂回来」的那一瞬,报 404。
		expect(await bridgeState()).toBe("running");
		await handshake();
	});

	/** 现在拓展什么状态 —— 这一口会先把还没落地的开关 settle 掉,是「等它装完」的正路。 */
	async function bridgeState(): Promise<string | undefined> {
		const res = await fetch(`${handle?.url}/api/ext`);
		const body = (await res.json()) as { extensions: Array<{ id: string; state: string }> };
		return body.extensions.find((e) => e.id === "bridge")?.state;
	}

	function setBridgeEnabled(enabled: boolean): Promise<Response> {
		return fetch(`${handle?.url}/api/globals`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ extensions: { bridge: { enabled } } }),
		});
	}

	/** 连一次就丢 —— 只想知道 upgrade 是被谁、以什么理由挡下来的。 */
	async function peerOnce(): Promise<void> {
		const probe = peer(port, TOKEN);
		try {
			await probe.open();
		} finally {
			probe.dispose();
		}
	}
});
