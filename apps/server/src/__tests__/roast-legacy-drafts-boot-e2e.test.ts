/**
 * 🔴 **升级之前落盘的待审锐评草稿(按 uid 记),在真 BN 上批得动、发出去认得出人**(ADR-0020 决策 18)。
 *
 * 草稿库读盘时把老草稿的 uid 翻成订阅 id(`roast-draft-store.ts` 的 `upgradeLegacyDraft`),「这个 uid 现在是
 * 哪条 B 站订阅」由接线层现查订阅表递进去(`index.ts` 的 `subscriptionIdOfUid`)。草稿库的单元测试用的是自己
 * 造的查表函数;真 BN 里这根线只有类型兜着 —— 递一个永远回 `undefined` 的、或把 uid 原样当订阅 id 回的,
 * 类型、构建、单元测试全绿,症状是主人回了「y」没有下文(草稿读盘时全被丢了),或者群里收到一份「未知 UP」的周报。
 *
 * 所以走真的那条路:盘上摆好老草稿 → 开机 → 主人私聊「y <编号>」(devtools 的「私聊指令」,与 adapter 收到真帧
 * 之后调的是同一个入口)→ 审批 → 调度器按草稿里那份目标快照发 → 本地 webhook 收到的正文里写的是那几位的名字。
 *
 * B 站订阅都是**停用**的:草稿批出去不看订阅停没停,而停用的订阅不会让引擎或粉丝轮询去连 B 站。主人那条私聊
 * 目标挂在一条**停用**的 OneBot 连接上 —— 认主人只看目标的平台与地址,连接停着就不会去连一个不存在的 bot。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEmptySubscription } from "@bilibili-notify/internal";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";

const S101 = "5b000000-0000-4000-8000-000000000101";
const S102 = "5b000000-0000-4000-8000-000000000102";
const ONEBOT = "5b000000-0000-4000-8000-00000000c0b1";
const WEBHOOK = "5b000000-0000-4000-8000-00000000c0b2";
const MASTER_TARGET = "5b000000-0000-4000-8000-00000000a001";
const MASTER_QQ = "10001";

/** webhook(通用 JSON)收到的一条。 */
interface Hook {
	targetId: string;
	payload: { kind: string; text?: string };
}

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

describe("老草稿开机翻译 e2e:按 uid 记的待审锐评,开机后批得动、发出去写的是对的人", () => {
	let dataDir: string;
	let handle: StandaloneServerHandle | undefined;
	let port: number;
	let hookServer: Server;
	let webhookTarget: string;
	const hooks: Hook[] = [];

	const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
	const json = (body: unknown): RequestInit => ({
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	async function ok(res: Response): Promise<void> {
		expect(res.status, await res.clone().text()).toBe(200);
	}

	async function boot(): Promise<void> {
		port = await findFreePort();
		handle = await startStandaloneServer({
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
			shutdownTimeoutMs: 1_000,
		});
	}

	/** 主人在私聊里回一句 —— 与 adapter 收到真帧之后调的是同一个入口(指令分发的第二道门就是审批)。 */
	async function masterSays(text: string): Promise<void> {
		await ok(
			await api("/api/dev/run/inbound.command", { method: "POST", ...json({ params: { text } }) }),
		);
	}

	async function draftsOnDisk(): Promise<Array<Record<string, unknown>>> {
		return JSON.parse(await readFile(join(dataDir, "state", "roast-drafts.json"), "utf8"));
	}

	beforeAll(async () => {
		hookServer = createHttpServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				hooks.push(JSON.parse(body) as Hook);
				res.writeHead(200, { "content-type": "application/json" }).end("{}");
			});
		});
		await new Promise<void>((resolve) => hookServer.listen(0, "127.0.0.1", resolve));
		const address = hookServer.address();
		if (!address || typeof address === "string") throw new Error("webhook 没起来");

		// 第一趟:按面板那条路配连接、目标、主人(存盘时有校验)。
		dataDir = await mkdtemp(join(tmpdir(), "bn-roast-legacy-drafts-e2e-"));
		await boot();
		await ok(
			await api("/api/connections", {
				method: "POST",
				...json({
					id: ONEBOT,
					name: "主人的 bot",
					enabled: false,
					kind: "direct",
					connector: "http",
					platform: "onebot",
					config: { transport: "http", baseUrl: "http://127.0.0.1:9", headers: {} },
				}),
			}),
		);
		await ok(
			await api("/api/connections", {
				method: "POST",
				...json({
					id: WEBHOOK,
					name: "本地 webhook",
					enabled: true,
					kind: "direct",
					connector: "webhook",
					platform: "generic",
					config: { url: `http://127.0.0.1:${address.port}/hook`, headers: {} },
				}),
			}),
		);
		await ok(
			await api("/api/targets", {
				method: "POST",
				...json({
					id: MASTER_TARGET,
					name: "主人",
					connectionId: ONEBOT,
					scope: "private",
					enabled: true,
					kind: "session",
					platform: "onebot",
					address: MASTER_QQ,
				}),
			}),
		);
		await ok(
			await api("/api/globals", {
				method: "PATCH",
				...json({ master: { targetId: MASTER_TARGET } }),
			}),
		);
		const targets = (await (await api("/api/targets")).json()) as Array<{
			id: string;
			connectionId: string;
		}>;
		const found = targets.find((t) => t.connectionId === WEBHOOK);
		if (!found) throw new Error("webhook 连接没带出目标");
		webhookTarget = found.id;
		await handle?.close("seed");
		handle = undefined;

		// 两位 B 站 UP(停用,不连 B 站);盘上的订阅没有 kind(ADR-0019 决策 47)。
		const subs = [
			{ ...makeEmptySubscription({ id: S101, uid: "101" }), enabled: false },
			{ ...makeEmptySubscription({ id: S102, uid: "102" }), enabled: false },
		].map(({ kind: _kind, ...onDisk }) => onDisk);
		await writeFile(join(dataDir, "state", "subscriptions.json"), JSON.stringify(subs));

		// 升级之前写下的三份待审草稿 —— 按 uid 记。第三份的 uid 已经对不上任何订阅(期间退订了)。
		const now = Date.now();
		const stamp = {
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + 3_600_000).toISOString(),
		};
		await writeFile(
			join(dataDir, "state", "roast-drafts.json"),
			JSON.stringify([
				{
					id: "s2",
					kind: "solo",
					uid: "101",
					days: 7,
					targets: [webhookTarget],
					result: {
						uid: "101",
						verdict: "一周只发了一条",
						score: 30,
						highlights: [],
						pushText: "",
					},
					...stamp,
				},
				{
					id: "b3",
					kind: "board",
					days: 7,
					targets: [webhookTarget],
					result: {
						pigeon: { uid: "102", reason: "整周没动静" },
						diligent: { uid: "101", reason: "好歹发了一条" },
						roast: [
							{ uid: "101", comment: "勉强及格" },
							{ uid: "999", comment: "早就退订了" },
						],
						scores: [
							{ uid: "101", score: 60 },
							{ uid: "102", score: 10 },
						],
						pushText: "",
					},
					...stamp,
				},
				{
					id: "g4",
					kind: "solo",
					uid: "999",
					days: 7,
					targets: [webhookTarget],
					result: { uid: "999", verdict: "查无此人", score: 0, highlights: [], pushText: "" },
					...stamp,
				},
			]),
		);

		await boot();
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await new Promise<void>((resolve) => hookServer.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
	});

	it("老的单人草稿:主人回「y s2」→ 发到草稿里那份目标,正文写的是 uid 101 那条订阅;对不上订阅的那份开机就丢了", async () => {
		await masterSays("y s2");
		await vi.waitFor(
			() =>
				expect(hooks).toEqual([
					{
						targetId: webhookTarget,
						targetName: expect.any(String),
						scope: expect.any(String),
						private: false,
						payload: { kind: "text", text: "📊 UID 101（近 7 天）：一周只发了一条" },
						ts: expect.any(String),
					},
				]),
			{ timeout: 3_000, interval: 50 },
		);

		// 批走一份就落一次盘:剩下的只有那份榜单,已经是新形状(订阅 id、不带 uid);uid 999 那份开机时就丢了。
		const left = await draftsOnDisk();
		expect(left.map((d) => d.id)).toEqual(["b3"]);
		expect(left[0]?.uid).toBeUndefined();
		expect(left[0]?.result).toEqual({
			pigeon: { subscriptionId: S102, reason: "整周没动静" },
			diligent: { subscriptionId: S101, reason: "好歹发了一条" },
			roast: [{ subscriptionId: S101, comment: "勉强及格" }],
			scores: [
				{ subscriptionId: S101, score: 60 },
				{ subscriptionId: S102, score: 10 },
			],
			pushText: "",
		});
	}, 15_000);

	it("老的榜单草稿:主人回「y b3」→ 鸽王与勤奋 UP 都认得出是谁", async () => {
		await masterSays("y b3");
		await vi.waitFor(() => expect(hooks).toHaveLength(2), { timeout: 3_000, interval: 50 });
		expect(hooks[1]?.payload).toEqual({
			kind: "text",
			text: [
				"📊 UP 主周报（近 7 天）",
				"🕊️ 本期鸽王：UID 102 —— 整周没动静",
				"🏆 勤奋 UP：UID 101 —— 好歹发了一条",
			].join("\n"),
		});
		expect(await draftsOnDisk()).toEqual([]);
	}, 15_000);
});
