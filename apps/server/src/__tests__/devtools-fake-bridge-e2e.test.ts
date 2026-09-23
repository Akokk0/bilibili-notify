/**
 * 🔴 **devtools 那条假桥,对上真桥。**
 *
 * 假桥说的帧是**手写的第二份**(核心 import 不到拓展,ADR-0012 决策 42),而手写的东西会漂:
 * 桥那边改一个字段名、升一次协议 major,假桥仍旧编译得过、单元测试仍旧全绿 —— 症状是
 * 主人按下场景之后卡片不变绿,而**没有任何门禁会红**。
 *
 * 所以这一条把**真桥的构建产物**装进装载根、起一台真 BN,让 devtools 那条场景连一次:
 * 从「面板按钮」一路到「拓展 `publishView` 里真的多了一条会话」。这中间任意一环
 * (token 怎么读、地址怎么拼、帧长什么样、协议版本认不认)错了,这条就红。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionItemView,
	ExtensionPanelView,
	ExtensionTableCell,
} from "@bilibili-notify/contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import WebSocket from "ws";
import { STATUS_CHANGED_COALESCE_MS } from "../extensions/context.js";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";
import { installBridgeInto } from "./support/install-bridge.js";

const LINK_ID = "link-home";
const TOKEN = "devtools-fake-bridge-token";

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

interface StateFrame {
	type?: string;
	event?: string;
	data?: unknown;
}

/** 面板那条 WS:订 `state` 频道,把收到的帧攒着。 */
async function stateSubscriber(port: number) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const frames: StateFrame[] = [];
	const waiters: (() => void)[] = [];
	socket.on("message", (raw) => {
		frames.push(JSON.parse(raw.toString("utf8")) as StateFrame);
		for (const wake of waiters.splice(0)) wake();
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("error", reject);
	});
	socket.send(JSON.stringify({ type: "subscribe", channels: ["state"] }));
	return {
		/** 收到过几帧这样的。**接线的算术**靠它:少接一处,数就对不上。 */
		count(pred: (frame: StateFrame) => boolean): number {
			return frames.filter(pred).length;
		},
		async waitFor(pred: (frame: StateFrame) => boolean, timeoutMs: number): Promise<StateFrame> {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const hit = frames.find(pred);
				if (hit) return hit;
				if (Date.now() > deadline) {
					throw new Error(`没等到那一帧;收到过:${JSON.stringify(frames.map((f) => f.event))}`);
				}
				await new Promise<void>((resolve) => {
					waiters.push(resolve);
					setTimeout(resolve, 50);
				});
			}
		},
		close() {
			socket.close();
		},
	};
}

describe("devtools 的假桥 → 真桥", () => {
	let dataDir: string;
	let handle: StandaloneServerHandle | undefined;
	let port: number;

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-fake-bridge-"));
		const seed = await boot(await findFreePort());
		await seed.close("seed");

		const globalsPath = join(dataDir, "state", "globals.json");
		const globals = JSON.parse(await readFile(globalsPath, "utf8")) as Record<string, unknown>;
		// 接入(token)住桥自己的设置里 —— 场景从那儿挑(ADR-0012 决策 45)。
		globals.extensions = {
			bridge: {
				enabled: true,
				settings: {
					links: [
						{
							id: LINK_ID,
							name: "家里那台 koishi",
							enabled: true,
							token: TOKEN,
							bridgeKind: "koishi",
						},
					],
				},
			},
		};
		await installBridgeInto(dataDir);
		await writeFile(globalsPath, JSON.stringify(globals));
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
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
	});

	async function runScenario(id: string, params: Record<string, unknown> = {}): Promise<Response> {
		return fetch(`http://127.0.0.1:${port}/api/dev/run/${id}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ params }),
		});
	}

	async function status(): Promise<Record<string, unknown>> {
		const res = await fetch(`http://127.0.0.1:${port}/api/ext/bridge/status`);
		expect(res.status).toBe(200);
		return (await res.json()) as Record<string, unknown>;
	}

	/** 帧是异步到达的(WS → 端点 → publishView),所以状态接口要等,不能只读一次。 */
	async function statusUntil(
		pred: (snapshot: Record<string, unknown>) => boolean,
		timeoutMs = 2_000,
	): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		let last: Record<string, unknown> = {};
		while (Date.now() < deadline) {
			last = await status();
			if (pred(last)) return last;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error(`状态一直没变成要的样子;最后一次是:${JSON.stringify(last)}`);
	}

	/** 视图里唯一那条接入的样子(配置里只摆了一条)。 */
	function theItem(snapshot: Record<string, unknown>): ExtensionItemView | undefined {
		const slot = Object.values((snapshot as ExtensionPanelView).items?.links ?? {})[0];
		return slot && "view" in slot ? slot.view : undefined;
	}

	/** 那条接入的 bot 表的第一行 —— 方块、名字,然后六项能力。 */
	function firstBotRow(
		snapshot: Record<string, unknown>,
	): readonly ExtensionTableCell[] | undefined {
		const table = theItem(snapshot)?.blocks?.find((block) => block.type === "table");
		return table?.type === "table" ? table.rows[0] : undefined;
	}

	/** 连着没有 —— 桥交的视图里那一项是「已连接」。 */
	function connected(snapshot: Record<string, unknown>): boolean {
		return theItem(snapshot)?.status?.tone === "ok";
	}

	/**
	 * 第二份名单快照(插件探完能力那份)到了没有。握手那份一格能力都不报,归一化之后
	 * 六项全是「还不知道」;出现任何一个真答案,就说明第二份已经落地了。
	 */
	function probedCapabilities(snapshot: Record<string, unknown>): boolean {
		return (firstBotRow(snapshot) ?? [])
			.slice(2)
			.some((cell) => cell.kind === "tristate" && cell.value === "yes");
	}

	it("按一下场景 → 真桥那头真的多了一条握过手的会话,bot 名单与能力表都在", async () => {
		// 按之前:配着一条接入,但没人连 —— 拓展页上那张卡是灰的。
		expect(connected(await status())).toBe(false);

		const res = await runScenario("bridge.connect", { platform: "telegram", caps: "mixed" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { summary?: string; active: { scenarioId: string }[] };
		expect(body.summary).toContain("家里那台 koishi");
		expect(body.active.map((a) => a.scenarioId)).toContain("bridge.connect");

		// 🔴 能力**在第二份快照里**(握手那份是「还没探」的样子),所以得等它到。
		const after = await statusUntil(probedCapabilities);
		// 配置里是 koishi、连进来的也自报 koishi —— 「已连接」而不是「对不上」。
		expect(theItem(after)?.status).toEqual({ tone: "ok", text: "已连接" });
		const table = theItem(after)?.blocks?.find((block) => block.type === "table");
		if (table?.type !== "table") throw new Error("应该有一张 bot 表");
		expect(table.rows).toHaveLength(1);
		const row = firstBotRow(after) ?? [];
		expect(row[1]).toMatchObject({ kind: "text", sub: expect.stringContaining("telegram") });
		// 🔴 平台图标一路走到状态接口:桥只收 data URL,http 地址会在归一化那关被丢掉,
		// 所以「有」本身就证明了假桥造的那枚是合法的。图进视图顶层的字典,格子按键引用(决策 39)。
		const icon = row[0];
		const key = icon?.kind === "icon" ? icon.image : undefined;
		expect(key && (after as ExtensionPanelView).images?.[key]).toMatch(
			/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/,
		);
		// 🔴 三态齐全:桥把没报的补成「还不知道」,面板据此分「不支持」与「还不知道」。
		expect(new Set(row.slice(2).map((cell) => cell.kind === "tristate" && cell.value))).toEqual(
			new Set(["yes", "no", "unknown"]),
		);
	});

	it("一键收摊 → 那条会话当场没了(假状态只由 devtools 收摊)", async () => {
		await runScenario("bridge.connect");
		expect(connected(await statusUntil(connected))).toBe(true);

		const res = await fetch(`http://127.0.0.1:${port}/api/dev/reset`, { method: "POST" });
		expect(res.status).toBe(200);

		// 断开是异步到达的(socket 关闭 → 端点摘表)。
		const deadline = Date.now() + 1_000;
		let still = true;
		while (Date.now() < deadline) {
			still = connected(await status());
			if (!still) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(still).toBe(false);
	});

	/**
	 * 🔴 「桥握完手 → 面板当场变绿」整条接线:桥 `ctx.statusChanged()` → 宿主 bus
	 * `extension-status-changed` → WS `state` 频道一帧 `extension-changed`。零件各自的测试
	 * 证明不了它们真的接上了 —— index.ts 那一行漏接,四层全绿而面板照旧要切页。
	 */
	it("桥握完手 → state 频道推一帧 extension-changed(面板据此重取,不用切页)", async () => {
		const panel = await stateSubscriber(port);
		try {
			await runScenario("bridge.connect");
			const frame = await panel.waitFor((f) => f.event === "extension-changed", 3_000);
			expect(frame.type).toBe("state");
			expect(frame.data).toEqual({ id: "bridge" });
		} finally {
			panel.close();
		}
	});

	/**
	 * 🔴 **名单再来一份,面板也得知道**。插件探完能力会重推一份全量快照(bot 上下线同理),面板上
	 * 那张能力矩阵得跟着换 —— 否则状态接口里查得到真答案,屏幕上却是一片「还不知道」,直到主人切一次页。
	 *
	 * 宿主**按拓展合并**连喊(`STATUS_CHANGED_COALESCE_MS`):握手喊两声(会话 + 握手那份名单)、第二份
	 * 快照再喊一声,三声只差几毫秒,落在同一个窗口里 —— state 频道推的**少于三帧**(一般是一帧);面板
	 * **照最后一帧重取**,看到的已经是探完那份。
	 *
	 * ⚠️ 两样它钉不住,各在别处钉着:
	 * - 「尾沿」:同一个进程里第二份快照几毫秒就落地,「先发、窗口里的吞掉」那种合并重取也总赶在它之后
	 *   (真跑过,照样绿)—— 尾沿在 ctx 的单测里用假定时器钉着(`context-grants.test.ts`「statusChanged 合并」);
	 * - 「桥在 onBots 里也喊了一声」:第二份快照落在窗口里,握手那一声就把它带上了 —— 在桥自己的 e2e 里
	 *   钉着(「bots 快照又来一份 → 再喊一声 statusChanged」)。
	 */
	it("握手连着探完能力的名单 → 连喊合并成尾沿那一帧,照最后一帧重取看到的是探完那份", async () => {
		const panel = await stateSubscriber(port);
		const changed = (f: StateFrame) => f.event === "extension-changed";
		try {
			await runScenario("bridge.connect");
			// 面板的做法:收到帧就重取一次。一直跟到安静下来(两个窗口没有新帧),记下最后那次重取。
			let handled = 0;
			let lastRefetch: boolean | undefined;
			for (;;) {
				const seen = handled;
				try {
					await panel.waitFor(
						() => panel.count(changed) > seen,
						seen === 0 ? 3_000 : 2 * STATUS_CHANGED_COALESCE_MS,
					);
				} catch {
					break;
				}
				handled = panel.count(changed);
				lastRefetch = probedCapabilities(await status());
			}
			expect(handled).toBeGreaterThanOrEqual(1);
			expect(handled).toBeLessThan(3);
			expect(lastRefetch).toBe(true);
		} finally {
			panel.close();
		}
	});

	/** 桥驮上来的私聊 —— 真入站链路,核心那条「私聊指令」场景够不着桥。 */
	it("驮一条私聊上去,真桥收得下(不是 400 也不是断连)", async () => {
		await runScenario("bridge.connect");
		const res = await runScenario("bridge.inbound", { from: "10086", text: "/help" });
		expect(res.status).toBe(200);
		// 驮完之后连接还在 —— 帧畸形的话桥会以 4003 把它踢掉。
		expect(connected(await status())).toBe(true);
	});
});
