/**
 * 🔴 **AI 写正文按目标选,在真 BN 上真的分开发了**(ADR-0032 决策 1 / 2)。
 *
 * 装配备两份正文(模板、AI 点评)、推送层按目标挑、历史与重推各存各目标实际收到的那一份 ——
 * 零件各有单元测试,但**零件全绿证明不了接上了**:设置读口没接活的、锚点的 AI 版没翻过去、
 * 生成门算错,症状都只是「例外不生效」或「白调一次 AI」,没有任何报错。
 *
 * 所以起一台真 BN:假源报作品,两条 webhook 连接各带一个目标(收到什么记什么),AI 是回环地址上的
 * 假模型服务(固定回一句、记下被问了几次)。不出卡、不出图集,消息就是一条纯文字,看得清楚。
 *
 * - 默认设置(两份都开、无例外):行为同从前 —— 两个目标都收到点评,AI 调一次。
 * - 默认关、乙写了例外开:AI 照样只调一次,只有乙收到点评,甲收模板;历史两行各存各的,
 *   人工重推甲那一行,发出去的是它自己的模板版。
 * - 默认关、例外只指着一个已经不存在的目标:不算开着,AI 一次都不调,两边都是模板。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionLookupResponse, HistoryResponse } from "@bilibili-notify/contract";
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { installRepoExtensionInto } from "./support/install-repo-extension.js";

const FAKE = "fake-source";
const AI_REPLY = "按目标选出来的点评一句话";
const SUB_ID = "e9000000-0000-4000-8000-000000000001";
/** 乙的目标不是写死的(webhook 连接自动带出目标),甲乙各一条连接。 */
const CONNECTION = {
	a: "e9000000-0000-4000-8000-00000000c001",
	b: "e9000000-0000-4000-8000-00000000c002",
} as const;
/** 配置里不存在的目标 id(例外指着它 = 悬空)。 */
const GONE_TARGET = "e9000000-0000-4000-8000-0000000000ff";

interface Hook {
	key: string;
	payload: {
		kind: string;
		text?: string;
		segments?: Array<{ type: string; text?: string }>;
	};
}

/** webhook 收到的一条消息的文字(纯文字或图文混合都取文字段)。 */
const textOf = (hook: Hook | undefined): string =>
	hook?.payload.text ?? hook?.payload.segments?.find((s) => s.type === "text")?.text ?? "";

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

describe("AI 写正文按目标选 e2e:同一条作品,不同目标收到不同的正文", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;
	let port: number;
	let hookServer: Server;
	let hookUrl: string;
	let aiServer: Server;
	let aiBaseUrl: string;
	const hooks: Hook[] = [];
	/** 甲回 500 期间收到、被拒的那几条。 */
	const rejected: Hook[] = [];
	let failA = false;
	/** 假模型服务被问了几次作品点评。 */
	let aiCalls = 0;
	const target = {} as Record<"a" | "b", string>;

	const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
	const json = (body: unknown, method = "POST"): RequestInit => ({
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	async function ok(res: Response): Promise<void> {
		expect(res.status, await res.clone().text()).toBeLessThan(300);
	}
	const patchSettings = async (body: unknown) =>
		ok(await api("/api/settings", json(body, "PATCH")));
	const hooksFor = (key: "a" | "b") => hooks.filter((h) => h.key === key);
	const reportPost = async () => ok(await api(`/api/ext/${FAKE}/actions/report.post`, json({})));
	/** 等两边各收到 `n` 条,再多等一会儿(重复发的会在这段时间里到)。 */
	async function bothReceived(n: number): Promise<void> {
		await vi.waitFor(
			() => {
				expect(hooksFor("a")).toHaveLength(n);
				expect(hooksFor("b")).toHaveLength(n);
			},
			{ timeout: 10_000 },
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(hooksFor("a")).toHaveLength(n);
		expect(hooksFor("b")).toHaveLength(n);
	}

	beforeAll(async () => {
		hookServer = createHttpServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				const hook = { ...(JSON.parse(body) as Hook), key: req.url?.split("/").pop() ?? "" };
				// 甲被指定"收不下"的那段时间:记进 rejected、回 500(让那一行落成失败,好测重推)。
				if (hook.key === "a" && failA) {
					rejected.push(hook);
					res.writeHead(500, { "content-type": "application/json" }).end("{}");
					return;
				}
				hooks.push(hook);
				res.writeHead(200, { "content-type": "application/json" }).end("{}");
			});
		});
		await new Promise<void>((resolve) => hookServer.listen(0, "127.0.0.1", resolve));
		const hookAddress = hookServer.address();
		if (!hookAddress || typeof hookAddress === "string") throw new Error("webhook 没起来");
		hookUrl = `http://127.0.0.1:${hookAddress.port}/hook`;

		// 假模型服务:OpenAI 兼容的最小回应,只听回环地址。
		aiServer = createHttpServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				// 设置保存时服务商的探活也会问一句;只数作品点评那一问(提示词里有「内容如下」)。
				if (body.includes("内容如下")) aiCalls += 1;
				res.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({
						id: "chatcmpl-fake",
						object: "chat.completion",
						created: 0,
						model: "fake-model",
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: AI_REPLY },
								finish_reason: "stop",
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
				);
			});
		});
		await new Promise<void>((resolve) => aiServer.listen(0, "127.0.0.1", resolve));
		const aiAddress = aiServer.address();
		if (!aiAddress || typeof aiAddress === "string") throw new Error("假模型服务没起来");
		aiBaseUrl = `http://127.0.0.1:${aiAddress.port}/v1`;

		dataDir = await mkdtemp(join(tmpdir(), "bn-ai-writing-by-target-e2e-"));
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
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});
		await patchSettings({ extensions: { [FAKE]: { enabled: true } } });
		// 不出图集:消息就是一条纯文字。AI 开着,服务商指向上面的回环假服务。
		await patchSettings({
			defaults: { imageGroup: { enabled: false } },
			ai: {
				...makeDefaultGlobalConfig().ai,
				enabled: true,
				activeProfile: "fake",
				providers: {
					fake: {
						provider: "deepseek",
						apiFlavor: "chat",
						label: "",
						apiKey: "sk-fake",
						baseUrl: aiBaseUrl,
						model: "fake-model",
						enableThinking: false,
						thinkingLevel: "medium",
						extraParams: "",
						enableVision: false,
						vision: { baseUrl: "", apiKey: "", model: "" },
					},
				},
			},
		});

		for (const key of ["a", "b"] as const) {
			await ok(
				await api(
					"/api/connections",
					json({
						id: CONNECTION[key],
						name: `本地 webhook ${key}`,
						enabled: true,
						adapterKey: "webhook",
						platform: "generic",
						settings: { url: `${hookUrl}/${key}`, headers: {} },
					}),
				),
			);
		}
		const targets = (await (await api("/api/targets")).json()) as Array<{
			id: string;
			connectionId: string;
		}>;
		for (const key of ["a", "b"] as const) {
			const found = targets.find((t) => t.connectionId === CONNECTION[key]);
			if (!found) throw new Error(`连接 ${key} 没带出目标`);
			target[key] = found.id;
		}

		const looked = await api(`/api/ext/${FAKE}/lookup?q=${encodeURIComponent("作品探针")}`);
		await ok(looked);
		const candidate = ((await looked.json()) as ExtensionLookupResponse).candidates[0];
		if (!candidate) throw new Error("解析门没交候选");
		const base = makeExtensionSubscription({
			id: SUB_ID,
			extensionId: FAKE,
			externalId: candidate.externalId,
			enabled: true,
		});
		await ok(
			await api(
				"/api/subscriptions",
				json({
					...base,
					routing: { ...base.routing, post: [target.a, target.b] },
					cachedProfile: { name: candidate.name },
				}),
			),
		);
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await new Promise<void>((resolve) => hookServer.close(() => resolve()));
		await new Promise<void>((resolve) => aiServer.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
	});

	it("默认设置(两份都开、无例外):两个目标都收到点评,AI 只调一次 —— 同从前", async () => {
		await reportPost();
		await bothReceived(1);
		expect(aiCalls).toBe(1);
		expect(textOf(hooksFor("a")[0])).toContain(AI_REPLY);
		expect(textOf(hooksFor("b")[0])).toContain(AI_REPLY);
	}, 20_000);

	it("默认关、乙写了例外开:只生成一次,乙收到点评、甲收到模板;历史各存各的;重推甲那一行发的是模板", async () => {
		await patchSettings({
			ai: { writing: { post: { isOnByDefault: false, byTarget: { [target.b]: true } } } },
		});
		// 甲先"收不下"(回 500):它那一行落成失败,稍后好拿来人工重推。
		failA = true;
		await reportPost();
		await vi.waitFor(() => expect(hooksFor("b")).toHaveLength(2), { timeout: 10_000 });
		await vi.waitFor(() => expect(rejected.length).toBeGreaterThan(0), { timeout: 10_000 });
		expect(aiCalls).toBe(2);
		expect(textOf(rejected[0])).not.toContain(AI_REPLY);
		expect(textOf(rejected[0])).toContain("发布了"); // 模板文案
		expect(textOf(hooksFor("b")[1])).toContain(AI_REPLY);

		// 历史:同一次推送两行,各存它那个目标实际收到的那一份。
		const latestRows = async () => {
			const { entries } = (await (await api("/api/history?limit=50")).json()) as HistoryResponse;
			const newest = entries[0]?.pushId;
			return entries.filter((e) => e.pushId === newest);
		};
		await vi.waitFor(
			async () => {
				const rows = await latestRows();
				expect(rows).toHaveLength(2);
				const rowA = rows.find((r) => r.targetId === target.a);
				const rowB = rows.find((r) => r.targetId === target.b);
				expect(rowA?.status).toBe("failed");
				expect(rowA?.messages[0]?.text).not.toContain(AI_REPLY);
				expect(rowB?.messages[0]?.text).toContain(AI_REPLY);
			},
			{ timeout: 10_000 },
		);

		// 甲好了,人工重推它那一行:发出去的就是甲自己的模板版,不是乙那份点评。
		failA = false;
		const rowA = (await latestRows()).find((r) => r.targetId === target.a);
		if (!rowA) throw new Error("没找到甲那一行");
		const before = hooksFor("a").length;
		const res = await api(
			`/api/history/${rowA.id}/repush`,
			json({ createdAt: rowA.createdAt, mode: "all" }),
		);
		expect(res.status, await res.clone().text()).toBe(202);
		await vi.waitFor(() => expect(hooksFor("a").length).toBeGreaterThan(before), {
			timeout: 10_000,
		});
		expect(textOf(hooksFor("a").at(-1))).toBe(textOf(rejected[0]));
		expect(textOf(hooksFor("a").at(-1))).not.toContain(AI_REPLY);
	}, 30_000);

	it("默认关、例外只指着已经不存在的目标:不算开着,AI 一次都不调,两边都是模板", async () => {
		// 乙那条例外删掉(面板发 null),换成一条指着不存在的目标的。
		await patchSettings({
			ai: { writing: { post: { byTarget: { [target.b]: null, [GONE_TARGET]: true } } } },
		});
		const callsBefore = aiCalls;
		const aBefore = hooksFor("a").length;
		const bBefore = hooksFor("b").length;
		await reportPost();
		await vi.waitFor(
			() => {
				expect(hooksFor("a").length).toBe(aBefore + 1);
				expect(hooksFor("b").length).toBe(bBefore + 1);
			},
			{ timeout: 10_000 },
		);
		expect(aiCalls).toBe(callsBefore);
		expect(textOf(hooksFor("a").at(-1))).not.toContain(AI_REPLY);
		expect(textOf(hooksFor("b").at(-1))).not.toContain(AI_REPLY);
	}, 20_000);
});
