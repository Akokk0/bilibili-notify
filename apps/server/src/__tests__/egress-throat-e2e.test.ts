/**
 * 🔴 **出口咽喉 e2e:每条往外发的路,在真 BN 上恰好从咽喉过一次**(ADR-0024 决策 13 / 14,`docs/1.0/push.md`
 * 「出口咽喉」)。
 *
 * 咽喉的约束是「只有 `TargetDispatcher` 能发送」。源码扫描钉的是**不许有第二条路**,钉不住的是
 * **这条路真的走了咽喉、而且只走了一次**:某条路改了发送口、重复发、或绕开了截流闸(截流闸就接在咽喉里),
 * 单元测试各自全绿,症状是主人那头多一条 / 少一条,或者「测试推送」其实没经过真的出口。
 *
 * 所以这一条起一台真 BN,开 devtools 的推送截流(接在派发器调适配器 `send` 的那一处,开着不出网),
 * 逐条驱动能驱动的发送路径:每条先清空截流记录 → 驱动 → 断言记录**恰好多了一条**、且是这条路该有的
 * 目标 / 会话。走不到发送那一步的路径列在 {@link SEND_PATHS},每条带一句理由,免得清单悄悄漏掉。
 *
 * 接收端不出本机:一条 OneBot(HTTP)连接指向一个**不监听**的本机回环端口 —— 截流开着时适配器的 `send`
 * 压根不会被调到;唯一需要真发的那一次(造一行「没送到」的历史,好让重推有东西补)是回环上的连接被拒。
 * AI 那一跳是起在回环上的假模型服务。联网守卫(`scripts/network-guard.mjs`)对每条测试自动查账,只许回环。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	DevCapturedDelivery,
	ExtensionLookupResponse,
	ExtensionsResponse,
	HistoryResponse,
} from "@bilibili-notify/contract";
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { installRepoExtensionInto } from "./support/install-repo-extension.js";

/**
 * 全部发送路径的清单。**往外发的路只能多、不能悄悄多**:加一条路就得来这里登记,说明它走了咽喉的
 * 哪个口、这条 e2e 驱动没驱动(没驱动的写清为什么走不到)。
 */
const SEND_PATHS = [
	{ id: "subscription-broadcast", label: "订阅广播", driven: true },
	{ id: "notify-master", label: "通知主人", driven: true },
	{ id: "target-test", label: "目标测试", driven: true },
	{
		id: "card-send",
		label: "卡片发送",
		driven: false,
		reason: "测试环境没有浏览器,接口在发送之前就返回了(要先出一张真卡才轮得到发送)",
	},
	{ id: "ai-try", label: "AI 试一句", driven: true },
	{ id: "roast-delivery", label: "锐评投递", driven: true },
	{ id: "manual-repush", label: "人工重推", driven: true },
	{
		id: "link-reply",
		label: "链接回复",
		driven: false,
		reason: "要先向 B 站查视频信息才轮得到发送(图片卡还要浏览器),测试里不许调真实的 B 站接口",
	},
	{ id: "command-reply", label: "指令回复", driven: true },
	{
		id: "login-qr",
		label: "登录二维码",
		driven: false,
		reason:
			"要先向 B 站申请二维码才轮得到发送,测试里不许调真实的 B 站接口(发图走的是指令回复同一个口)",
	},
	{ id: "approval-preview", label: "审批预览卡", driven: true },
] as const;

type SendPathId = (typeof SEND_PATHS)[number]["id"];

/** 这条 e2e 里每个「驱动」用例实际驱动到的路径;末尾一条用例拿它对清单,免得清单与用例两边各写各的。 */
const drivenInThisRun = new Set<SendPathId>();

/** 一个回环上的空闲端口(取到就放掉,没人监听 —— 往上连一定被拒)。 */
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

const FAKE = "fake-source";
const ID = {
	connection: "ee000000-0000-4000-8000-00000000c001",
	master: "ee000000-0000-4000-8000-0000000000a1",
	group: "ee000000-0000-4000-8000-0000000000a2",
	subA: "ee000000-0000-4000-8000-000000000001",
	subB: "ee000000-0000-4000-8000-000000000002",
} as const;
const MASTER_USER = "10001";
const GROUP_ADDRESS = "88888";
const AI_REPLY = "在的主人~测试女仆回话";
/** 假模型对锐评那一问的回答(下标 0、1 对上榜单里的两条订阅)。 */
const ROAST_REPLY = JSON.stringify({
	pigeon: { i: 0, reason: "最近没动静" },
	diligent: { i: 1, reason: "很勤快" },
	roast: [{ i: 0, comment: "鸽了" }],
	scores: [
		{ i: 0, score: 10 },
		{ i: 1, score: 90 },
	],
	pushText: "本周周报:有人勤快有人鸽。",
});

describe("出口咽喉 e2e:逐条驱动发送路径,每条恰好一条截流记录", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;
	let port: number;
	let aiServer: Server;
	let aiBaseUrl: string;
	/** 假模型服务收到的每一问(用户那句)。 */
	const aiAsked: string[] = [];

	const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
	const json = (body: unknown, method = "POST"): RequestInit => ({
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	async function okRes(res: Response): Promise<Response> {
		expect(res.status, await res.clone().text()).toBeLessThan(300);
		return res;
	}

	/** 截流记录(devtools 那一路)。 */
	async function captures(): Promise<DevCapturedDelivery[]> {
		const res = await okRes(await api("/api/dev/captures"));
		return ((await res.json()) as { entries: DevCapturedDelivery[] }).entries;
	}
	async function clearCaptures(): Promise<void> {
		await okRes(await api("/api/dev/captures/clear", { method: "POST" }));
		expect(await captures()).toEqual([]);
	}

	/**
	 * 清空 → 驱动 → 断言**恰好多一条**。`async` 的路(后台发出去的)先等到第一条再多等一会儿,
	 * 要是它重复发了,第二条会在这段时间里到。
	 */
	async function exactlyOneCapture(
		path: SendPathId,
		drive: () => Promise<void>,
		opts: { async?: boolean } = {},
	): Promise<DevCapturedDelivery> {
		await clearCaptures();
		await drive();
		if (opts.async) {
			await vi.waitFor(async () => expect((await captures()).length).toBeGreaterThanOrEqual(1), {
				timeout: 10_000,
			});
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
		const entries = await captures();
		expect(entries, `${path} 应当恰好一条截流记录`).toHaveLength(1);
		drivenInThisRun.add(path);
		return entries[0] as DevCapturedDelivery;
	}

	beforeAll(async () => {
		// —— 假模型服务:OpenAI 兼容的最小回应,只听回环地址。锐评那一问(提示词里带 pushText 格)回 JSON,
		// 其余回一句话。
		aiServer = createHttpServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				const messages = (JSON.parse(body || "{}") as { messages?: { content?: unknown }[] })
					.messages;
				const asked = JSON.stringify(messages?.at(-1)?.content ?? "");
				aiAsked.push(asked);
				const content = asked.includes("pushText") ? ROAST_REPLY : AI_REPLY;
				res.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({
						id: "chatcmpl-fake",
						object: "chat.completion",
						created: 0,
						model: "fake-model",
						choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
				);
			});
		});
		await new Promise<void>((resolve) => aiServer.listen(0, "127.0.0.1", resolve));
		const aiAddress = aiServer.address();
		if (!aiAddress || typeof aiAddress === "string") throw new Error("假模型服务没起来");
		aiBaseUrl = `http://127.0.0.1:${aiAddress.port}/v1`;

		dataDir = await mkdtemp(join(tmpdir(), "bn-egress-throat-e2e-"));
		await installRepoExtensionInto(dataDir, FAKE, "@bilibili-notify/extension-fake-source");

		port = await findFreePort();
		handle = await startServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			// 不配 Chrome:没有出卡的渲染器,锐评与审批预览走文字降级那条路。
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});

		// —— 接收端:一条 OneBot(HTTP)连接,指向没人监听的回环端口。
		await okRes(
			await api(
				"/api/connections",
				json({
					id: ID.connection,
					name: "本机回环 bot",
					enabled: true,
					kind: "direct",
					connector: "http",
					platform: "onebot",
					config: {
						transport: "http",
						baseUrl: `http://127.0.0.1:${await findFreePort()}`,
						retryTimes: 0,
						retryIntervalMs: 0,
					},
				}),
			),
		);
		for (const [id, name, scope, address] of [
			[ID.master, "主人", "private", MASTER_USER],
			[ID.group, "测试群", "group", GROUP_ADDRESS],
		] as const) {
			await okRes(
				await api(
					"/api/targets",
					json({
						id,
						name,
						connectionId: ID.connection,
						kind: "session",
						scope,
						address,
						enabled: true,
					}),
				),
			);
		}
		await okRes(await api("/api/settings", json({ master: { targetId: ID.master } }, "PATCH")));

		// —— 假源:两条订阅,甲的作品推到测试群,乙不路由(只给锐评榜单凑够两位)。
		await okRes(
			await api("/api/settings", json({ extensions: { [FAKE]: { enabled: true } } }, "PATCH")),
		);
		const listed = (await (await api("/api/ext")).json()) as ExtensionsResponse;
		expect(listed.extensions.find((e) => e.id === FAKE)?.state).toBe("running");
		const looked = await okRes(
			await api(`/api/ext/${FAKE}/lookup?q=${encodeURIComponent("探针")}`),
		);
		const { candidates } = (await looked.json()) as ExtensionLookupResponse;
		for (const [i, subId] of [ID.subA, ID.subB].entries()) {
			const candidate = candidates[i];
			if (!candidate) throw new Error("解析门少交了候选");
			const base = makeExtensionSubscription({
				id: subId,
				extensionId: FAKE,
				externalId: candidate.id,
				enabled: true,
			});
			await okRes(
				await api(
					"/api/subscriptions",
					json({
						...base,
						routing: { ...base.routing, post: i === 0 ? [ID.group] : [] },
						cachedProfile: { name: candidate.name },
					}),
				),
			);
		}

		// —— 智能女仆:指向假模型服务(启用前的预检会真问它一句,假服务答得上)。锐评的定时配置:
		// 审批开着、目标是测试群(审批预览那条用)。
		const ai = makeDefaultGlobalConfig().defaults.ai;
		await okRes(
			await api(
				"/api/settings",
				json(
					{
						defaults: { ai: { ...aiSettings(ai), enabled: true } },
						roastSchedule: { targets: [ID.group], approval: true },
					},
					"PATCH",
				),
			),
		);
	}, 30_000);

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await new Promise<void>((resolve) => aiServer.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
	});

	/** 指向假模型服务的 AI 草稿设置(同时给 `/api/ai/test` 当请求体、给设置的 PATCH 当补丁)。 */
	function aiSettings(base: ReturnType<typeof makeDefaultGlobalConfig>["defaults"]["ai"]) {
		return {
			...base,
			activeProfile: "fake",
			providers: {
				fake: {
					provider: "deepseek" as const,
					apiFlavor: "chat",
					label: "",
					apiKey: "sk-fake",
					baseUrl: aiBaseUrl,
					model: "fake-model",
					enableThinking: false,
					thinkingLevel: "medium" as const,
					extraParams: "",
					enableVision: false,
					vision: { baseUrl: "", apiKey: "", model: "" },
				},
			},
		};
	}

	/** 行上没送到的那一条甲的作品推送(重推要补的)。 */
	let failedRowId: string | undefined;
	let failedRowCreatedAt: string | undefined;

	it("清单:每条路各自恰好属于「驱动」或「没驱动」,没驱动的每条理由非空", () => {
		expect(SEND_PATHS).toHaveLength(11);
		expect(new Set(SEND_PATHS.map((p) => p.id)).size).toBe(11);
		for (const p of SEND_PATHS) {
			expect(typeof p.driven, p.id).toBe("boolean");
			if (!p.driven) {
				expect(p.reason.trim().length, `${p.id} 没驱动要说理由`).toBeGreaterThan(0);
			}
		}
	});

	it("造一行没送到的历史(截流关着,回环上连接被拒),给人工重推准备原料", async () => {
		expect((await (await api("/api/dev/captures")).json()) as { enabled: boolean }).toMatchObject({
			enabled: false,
		});
		await okRes(await api(`/api/ext/${FAKE}/actions/report.post`, { method: "POST" }));
		await vi.waitFor(
			async () => {
				const { entries } = (await (await api("/api/history?limit=50")).json()) as HistoryResponse;
				const row = entries.find((e) => e.subscriptionId === ID.subA && e.status !== "filtered");
				expect(row?.status).toBe("failed");
				failedRowId = row?.id;
				failedRowCreatedAt = row?.createdAt;
			},
			{ timeout: 15_000 },
		);
		// 开截流:后面每条用例都在它开着的时候驱动。
		await okRes(await api("/api/dev/run/push.capture", json({ params: {} })));
	}, 20_000);

	it("订阅广播:假源报一条作品 → 甲只路由到测试群,本体一个锚点,恰好一条", async () => {
		const hit = await exactlyOneCapture(
			"subscription-broadcast",
			async () => {
				await okRes(await api(`/api/ext/${FAKE}/actions/report.post`, { method: "POST" }));
			},
			{ async: true },
		);
		expect(hit).toMatchObject({ targetId: ID.group, connectionId: ID.connection, private: false });
	});

	it("通知主人:服务端主动告警(engine-error)→ notifyMaster 发到主人目标,恰好一条", async () => {
		const hit = await exactlyOneCapture(
			"notify-master",
			async () => {
				await okRes(await api("/api/dev/run/engine.error", json({ params: {} })));
			},
			{ async: true },
		);
		expect(hit).toMatchObject({ targetId: ID.master, connectionId: ID.connection, private: true });
	});

	it("目标测试:POST /api/targets/:id/test → 发到那个目标,恰好一条", async () => {
		const hit = await exactlyOneCapture("target-test", async () => {
			await okRes(await api(`/api/targets/${ID.group}/test`, json({ kind: "text" })));
		});
		expect(hit).toMatchObject({ targetId: ID.group, connectionId: ID.connection, private: false });
	});

	it("AI 试一句:假模型答一句 → 推到那个目标,恰好一条,推的是模型那句回话", async () => {
		const hit = await exactlyOneCapture("ai-try", async () => {
			const res = await okRes(
				await api(
					"/api/ai/test",
					json({
						targetId: ID.group,
						message: "在吗?",
						ai: { ...aiSettings(makeDefaultGlobalConfig().defaults.ai), enabled: true },
					}),
				),
			);
			expect(await res.json()).toMatchObject({ ok: true, reply: AI_REPLY });
		});
		expect(hit).toMatchObject({ targetId: ID.group, kind: "text", private: false });
		expect(hit.text).toContain(AI_REPLY);
	});

	it("锐评投递:推一份榜单到测试群 → 文字降级(没有浏览器),恰好一条", async () => {
		const hit = await exactlyOneCapture("roast-delivery", async () => {
			const res = await okRes(
				await api(
					"/api/stats/roast/push",
					json({
						targetId: ID.group,
						days: 7,
						kind: "board",
						result: {
							pigeon: { subscriptionId: ID.subA, reason: "鸽" },
							diligent: { subscriptionId: ID.subB, reason: "勤" },
							roast: [],
							scores: [],
							pushText: "本周周报:测试一下。",
						},
					}),
				),
			);
			expect(await res.json()).toMatchObject({ ok: true, mode: "text" });
		});
		expect(hit).toMatchObject({ targetId: ID.group, kind: "text", private: false });
		expect(hit.text).toContain("本周周报");
	});

	it("人工重推:补那行没送到的 → 只多一条,发到原来的目标", async () => {
		expect(failedRowId, "上面那条用例没造出可补的行").toBeDefined();
		const hit = await exactlyOneCapture(
			"manual-repush",
			async () => {
				const res = await api(
					`/api/history/${failedRowId}/repush`,
					json({ createdAt: failedRowCreatedAt, mode: "missing" }),
				);
				expect(res.status, await res.clone().text()).toBe(202);
				expect(await res.json()).toMatchObject({ ok: true, count: 1 });
			},
			{ async: true },
		);
		expect(hit).toMatchObject({ targetId: ID.group, connectionId: ID.connection, private: false });
	});

	it("指令回复:私聊 /help → 回到「私聊 + 发指令的那个地址 + 那条连接」,恰好一条", async () => {
		const hit = await exactlyOneCapture(
			"command-reply",
			async () => {
				await okRes(await api("/api/dev/run/inbound.command", json({ params: { text: "/help" } })));
			},
			{ async: true },
		);
		// 这条回话不经目标表:按会话坐标发的,面板上显示成「私聊 <地址>」。
		expect(hit).toMatchObject({
			connectionId: ID.connection,
			private: true,
			targetName: `私聊 ${MASTER_USER}`,
			kind: "text",
		});
	});

	it("审批预览卡:跑一轮定时周报(审批开着)→ 预览私聊给主人(文字降级),恰好一条,群里还没发", async () => {
		const hit = await exactlyOneCapture(
			"approval-preview",
			async () => {
				const res = await okRes(await api("/api/stats/roast/run", { method: "POST" }));
				expect(await res.json()).toMatchObject({
					ok: true,
					outcome: { kind: "pending-approval" },
				});
			},
			{ async: true },
		);
		expect(hit).toMatchObject({
			targetId: ID.master,
			connectionId: ID.connection,
			private: true,
			kind: "text",
		});
		expect(hit.text).toContain("本周周报");
	});

	it("清单与用例对得上:标「驱动」的恰好都被驱动到了,标「没驱动」的一条也没碰", () => {
		const declared = new Set(SEND_PATHS.filter((p) => p.driven).map((p) => p.id));
		expect(drivenInThisRun).toEqual(declared);
	});
});
