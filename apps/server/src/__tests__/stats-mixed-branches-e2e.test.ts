/**
 * 🔴 **一台真 BN 里 B 站订阅与拓展订阅同在:统计页、首页粉丝面板、锐评各按各的规矩,互不串**(ADR-0020
 * 决策 1–3 / 8–10 / 12–16 / 18)。
 *
 * 单支的 e2e 各有一份(B 站:`stats-file-key-migration-boot-e2e`;拓展:`extension-stats-e2e`、`extension-roast-e2e`),
 * 两支**同在一台 BN** 才看得出来的是「谁借了谁的」:B 站行「那天有没有记录」只认 B 站那几位的粉丝采样、拓展行只认
 * 它自己的「在记」(决策 9);两支混在一张榜上、平台一列各写各的(决策 12);拓展的名字走资料那条链(决策 3)。
 * 路由测试用的是替身仓与替身引擎,这几根线在真 BN 里接没接上只有这里看得出来。
 *
 * - B 站那位:**停用**的(不连 B 站),盘上是升级之前的老数据(`<uid>.jsonl`、`{id, type, ts}` 行、字符串峰值),
 *   开机迁移挪到订阅 id 名下、读的时候翻。
 * - 拓展那位:假源,盘上先摆好前几天的「在记」、一条视频与两条粉丝样本(按订阅 id 命名),再按「报资料」——
 *   今天的「在记」、粉丝样本、资料缓存(名字、粉丝数、头像)都是真接线写的。
 *
 * 时区挑成「此刻是当地正午」:盘上的时刻都是「此刻往前整几天」,离日界线都有半天,不会因为跑测试的那一刻
 * 恰好跨了零点而错一天。
 *
 * **不碰真模型**:女仆的 `baseUrl` 指向本地一个假的 OpenAI 兼容端点 —— 请求原样记下(system 里的人格那一句、
 * user 里的数据表都看得见),按提示词回一份榜单或单人的 JSON。出卡的浏览器是假的(同 `extension-post-e2e`):
 * 截图交一串固定字节,灌进去的 HTML 留下来看头像是不是内嵌图。
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	FansResponse,
	StatsOverviewResponse,
	StatsRoastResponse,
	StatsRoastRunNowResponse,
	SubscriptionDTO,
} from "@bilibili-notify/contract";
import { makeEmptySubscription, upColor } from "@bilibili-notify/internal";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { installRepoExtensionInto } from "./support/install-repo-extension.js";

/** 假浏览器:截图恒交这串字节,灌进去的每一份 HTML 留下来。 */
const renderedHtml = vi.hoisted(() => [] as string[]);

vi.mock("../runtime/puppeteer.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../runtime/puppeteer.js")>();
	const page = () => ({
		setContent: async (html: string) => {
			renderedHtml.push(html);
		},
		waitForFunction: async () => undefined,
		$: async () => ({
			boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
			dispose: async () => {},
		}),
		screenshot: async () => Buffer.from("fake-card-jpeg"),
		close: async () => {},
	});
	const browser = () => ({
		connected: true,
		newPage: async () => page(),
		close: async () => {},
		disconnect: () => {},
		process: () => null,
	});
	return {
		...real,
		createPuppeteerAdapter: (opts: Parameters<typeof real.createPuppeteerAdapter>[0]) =>
			real.createPuppeteerAdapter({
				...opts,
				launcher: { launch: async () => browser(), connect: async () => browser() },
			}),
	};
});

const FAKE = "fake-source";
const S_BILI = "5c000000-0000-4000-8000-000000000101";
const UID = "101";
const S_EXT = "5c000000-0000-4000-8000-0000000000e1";
const EXT_ID = "mixed-ext-1";
const WEBHOOK = "5c000000-0000-4000-8000-00000000c0b2";

const D = 86_400_000;
const H = 3_600_000;

/** 假 OpenAI 端点收到的一次对话。 */
interface AiCall {
	system: string;
	user: string;
}

/** webhook(通用 JSON)收到的一条。 */
interface Hook {
	targetId: string;
	payload: { kind: string; text?: string; caption?: string; image?: { mime: string } };
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

/** 起一个只收 JSON 的本地 HTTP 服务,每个请求体交给 `onBody`,回它给的那份 JSON。 */
async function listenJson(
	onBody: (body: unknown) => unknown,
): Promise<{ server: Server; port: number }> {
	const server = createHttpServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const reply = onBody(JSON.parse(raw));
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("本地服务没起来");
	return { server, port: address.port };
}

const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

describe("B 站 + 拓展同在一台 BN e2e:统计页、粉丝面板、锐评按订阅 id 认人,两支各算各的", () => {
	let dataDir: string;
	let handle: StandaloneServerHandle | undefined;
	let port: number;
	let aiServer: Server;
	let hookServer: Server;
	let webhookTarget: string;
	const aiCalls: AiCall[] = [];
	const hooks: Hook[] = [];

	/** 「此刻」:盘上的时刻都从它往前数整天。 */
	const N = Date.now();
	const at = (daysAgo: number, hoursLater = 0) =>
		new Date(N - daysAgo * D + hoursLater * H).toISOString();
	/** 让 N 落在当地正午的时区(`getTimezoneOffset` 的口径:UTC − 当地,分钟)。 */
	const TZ = Math.floor((N % D) / 60_000) - 720;

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
			// 配了浏览器才有出卡的渲染器;真正起来的是上面那个假浏览器。
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1", BN_CHROME_PATH: "/fake/chrome" },
			shutdownTimeoutMs: 1_000,
		});
	}

	/** 盘上一个 jsonl 的每一行;文件不在是 `undefined`。 */
	async function lines(...path: string[]): Promise<Array<Record<string, unknown>> | undefined> {
		try {
			const raw = await readFile(join(dataDir, ...path), "utf8");
			return raw
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw err;
		}
	}

	async function exists(...path: string[]): Promise<boolean> {
		try {
			await stat(join(dataDir, ...path));
			return true;
		} catch {
			return false;
		}
	}

	async function extSub(): Promise<SubscriptionDTO | undefined> {
		const list = (await (await api("/api/subs")).json()) as SubscriptionDTO[];
		return list.find((s) => s.id === S_EXT);
	}

	beforeAll(async () => {
		// 假 OpenAI 端点:榜单回「B 站那位是鸽王、拓展那位最勤奋」(按提示词里的表找下标),单人回一份固定的。
		const ai = await listenJson((body) => {
			const messages = (body as { messages: Array<{ role: string; content: string }> }).messages;
			const system = messages.find((m) => m.role === "system")?.content ?? "";
			const user = messages.find((m) => m.role === "user")?.content ?? "";
			aiCalls.push({ system, user });
			let content: string;
			if (user.includes("鸽王")) {
				const table = JSON.parse(user.split("\n")[1] ?? "[]") as Array<{ i: number; 平台: string }>;
				const bili = table.find((r) => r.平台 === "B 站")?.i ?? -1;
				const other = table.find((r) => r.平台 !== "B 站")?.i ?? -1;
				content = JSON.stringify({
					pigeon: { i: bili, reason: "整周只有老存货" },
					diligent: { i: other, reason: "天天有动静" },
					roast: [],
					scores: [
						{ i: bili, score: 20 },
						{ i: other, score: 80 },
					],
					pushText: "",
				});
			} else {
				content = JSON.stringify({
					verdict: "还算勤快",
					score: 66,
					highlights: [{ label: "投稿", comment: "三天前发了一支视频" }],
					pushText: "这位本周还算勤快",
				});
			}
			return {
				id: "stub",
				object: "chat.completion",
				created: 0,
				model: "stub-model",
				choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
			};
		});
		aiServer = ai.server;
		const hook = await listenJson((body) => {
			hooks.push(body as Hook);
			return {};
		});
		hookServer = hook.server;

		// 第一趟:空启动拿到完整的 globals,顺手按面板那条路建一条 webhook 连接(它的目标由连接带出来)。
		dataDir = await mkdtemp(join(tmpdir(), "bn-stats-mixed-e2e-"));
		await boot();
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
					config: { url: `http://127.0.0.1:${hook.port}/hook`, headers: {} },
				}),
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

		const globalsPath = join(dataDir, "state", "globals.json");
		const globals = JSON.parse(await readFile(globalsPath, "utf8")) as {
			extensions: Record<string, unknown>;
			defaults: { ai: Record<string, unknown> };
		};
		globals.extensions = { [FAKE]: { enabled: true } };
		globals.defaults.ai = {
			...globals.defaults.ai,
			enabled: true,
			activeProfile: "stub",
			providers: {
				stub: {
					provider: "custom",
					apiKey: "stub-key",
					baseUrl: `http://127.0.0.1:${ai.port}/v1`,
					model: "stub-model",
				},
			},
		};
		await writeFile(globalsPath, JSON.stringify(globals));
		await installRepoExtensionInto(dataDir, FAKE, "@bilibili-notify/extension-fake-source");

		// B 站那位:停用(不连 B 站),盘上的订阅没有 kind(ADR-0019 决策 47)。
		const { kind: _kind, ...bili } = {
			...makeEmptySubscription({ id: S_BILI, uid: UID }),
			enabled: false,
		};
		await writeFile(join(dataDir, "state", "subscriptions.json"), JSON.stringify([bili]));
		// 拓展那位:开着,主人起过别名(资料里的名字要压过它,决策 3);单人锐评发到那条 webhook。
		const ext = makeExtensionSubscription({
			id: S_EXT,
			extensionId: FAKE,
			externalId: EXT_ID,
			name: "别名乙",
		});
		await writeFile(
			join(dataDir, "state", "extension-subscriptions.json"),
			JSON.stringify([
				{ ...ext, roastSchedule: { ...ext.roastSchedule, targets: [webhookTarget] } },
			]),
		);

		// 采集水位线:六天前(第一趟开机盖的是「现在」,B 站那几天的老数据会被它整片遮掉)。
		await writeFile(join(dataDir, "stats", "since"), at(6));
		for (const dir of [["fans"], ["stats", "dyn"], ["stats", "live"], ["stats", "seen"]]) {
			await mkdir(join(dataDir, ...dir), { recursive: true });
		}
		// B 站老数据(升级之前的写法,按 uid 命名)。粉丝采样五天前到昨天,今天没有(停用的不采)。
		await writeFile(
			join(dataDir, "fans", `${UID}.jsonl`),
			jsonl([5, 4, 3, 2, 1].map((d, i) => ({ ts: at(d), value: 1000 + 10 * i }))),
		);
		await writeFile(
			join(dataDir, "stats", "dyn", `${UID}.jsonl`),
			jsonl([
				{ id: "b-av", type: "DYNAMIC_TYPE_AV", ts: at(2) },
				{ id: "b-draw", type: "DYNAMIC_TYPE_DRAW", ts: at(3) },
				{ id: "b-live", type: "DYNAMIC_TYPE_LIVE_RCMD", ts: at(1) },
			]),
		);
		await writeFile(
			join(dataDir, "stats", "live", `${UID}.jsonl`),
			jsonl([
				{ k: "start", ts: at(4) },
				{ k: "end", ts: at(4, 2), peak: "1.2万" },
			]),
		);
		// 拓展前几天的(按订阅 id 命名):三天前、昨天在记;三天前一支视频;两条粉丝样本。
		await writeFile(
			join(dataDir, "stats", "seen", `${S_EXT}.jsonl`),
			jsonl([{ ts: at(3) }, { ts: at(1) }]),
		);
		await writeFile(
			join(dataDir, "stats", "dyn", `${S_EXT}.jsonl`),
			jsonl([{ id: "e-video", kind: "video", ts: at(3) }]),
		);
		await writeFile(
			join(dataDir, "fans", `${S_EXT}.jsonl`),
			jsonl([
				{ ts: at(3), value: 1000 },
				{ ts: at(1), value: 1050 },
			]),
		);

		await boot();
		const res = await api("/api/ext");
		const { extensions } = (await res.json()) as {
			extensions: Array<{ id: string; state: string }>;
		};
		expect(extensions.find((e) => e.id === FAKE)?.state).toBe("running");

		// 今天:假源紧挨着报两份资料(粉丝 1111、2222,带头像)。粉丝样本不密过 B 站的采样间隔,只落先到的 1111;
		// 资料缓存是最新的 2222 —— 两处「当前粉丝」于是分得出取的是哪一个(决策 8:取资料)。等三样都落了地 ——
		// 「在记」、粉丝样本(记录器排队写)、资料缓存(合并窗口满了才写)—— 再往下问,免得读到半截的盘、又被
		// overview 的缓存钉住。
		await ok(await api(`/api/ext/${FAKE}/actions/report.profile`, { method: "POST" }));
		await ok(await api(`/api/ext/${FAKE}/actions/report.profile`, { method: "POST" }));
		await vi.waitFor(
			async () => {
				expect(await lines("stats", "seen", `${S_EXT}.jsonl`)).toHaveLength(3);
				expect((await lines("fans", `${S_EXT}.jsonl`))?.map((row) => row.value)).toEqual([
					1000, 1050, 1111,
				]);
				const profile = (await extSub())?.cachedProfile;
				expect(profile?.fans).toBe(2222);
				expect(profile?.avatar).toMatch(/^\/api\/subs\//);
			},
			{ timeout: 3_000, interval: 50 },
		);
	}, 30_000);

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await new Promise<void>((resolve) => aiServer.close(() => resolve()));
		await new Promise<void>((resolve) => hookServer.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
	});

	it("统计页:两行按订阅 id 认;B 站行照老规矩(今天没采样就是无记录),拓展行的「那天有记录」只看它自己的「在记」", async () => {
		const res = await api(`/api/stats/overview?days=7&tz=${TZ}`);
		expect(res.status).toBe(200);
		const { rows } = (await res.json()) as StatsOverviewResponse;
		expect(rows.map((r) => r.subscriptionId).sort()).toEqual([S_BILI, S_EXT].sort());

		const bili = rows.find((r) => r.subscriptionId === S_BILI);
		expect(bili).toMatchObject({
			uid: UID,
			fans: 1040,
			archives: 1,
			dynamics: 1,
			liveSessions: 1,
			liveHours: 2,
			liveTimedSessions: 1,
			maxViewers: 12000,
			avgViewers: 12000,
			lastActivityAt: at(1),
			live: false,
			// 六天前:采集之前没采样;五天前到昨天有 B 站采样;今天 B 站没采(停用)—— 拓展今天报的资料不算数。
			activity: [null, 0, 1, 1, 1, 0, null],
		});
		expect(bili?.extensionId).toBeUndefined();

		const ext = rows.find((r) => r.subscriptionId === S_EXT);
		expect(ext).toMatchObject({
			extensionId: FAKE,
			externalId: EXT_ID,
			// 当前粉丝取最近报的资料(2222),不取稀释过的样本末值(1111)。
			fans: 2222,
			archives: 1,
			dynamics: 0,
			liveSessions: 0,
			maxViewers: null,
			lastActivityAt: at(3),
			live: false,
			// 三天前之前没开始记(B 站那几天在采也不借);四天前那天没「在记」、也没作品 —— 无记录;昨天、今天在记。
			activity: [null, null, null, 1, null, 0, 0],
		});
		expect(ext?.uid).toBeUndefined();
	});

	it("首页粉丝面板:拓展那一行上得来(当前是最近报的资料,起点是盘上第一条样本,24h 比昨天那条);停用的 B 站那位不在", async () => {
		await vi.waitFor(
			async () => {
				await ok(
					await api("/api/dev/run/fans.poll-now", { method: "POST", ...json({ params: {} }) }),
				);
				const { entries } = (await (await api("/api/fans")).json()) as FansResponse;
				expect(entries).toEqual([
					{
						subscriptionId: S_EXT,
						extensionId: FAKE,
						externalId: EXT_ID,
						current: 2222,
						ts: expect.any(String),
						deltaSubscribed: 1222,
						delta24h: 1172,
						delta7d: null,
					},
				]);
			},
			{ timeout: 3_000, interval: 100 },
		);
	}, 15_000);

	it("榜单锐评:两支混在一张表里、平台一列各写各的,名字走资料那条链;人格那一句不再只说 B 站;结果按订阅 id 回指", async () => {
		const res = await api(`/api/stats/roast?days=7&tz=${TZ}`, { method: "POST", ...json({}) });
		const body = (await res.json()) as StatsRoastResponse;

		// 先看喂给女仆的是什么(假端点按平台一列挑鸽王,表错了它也回不出像样的 JSON),再看结果。
		const calls = aiCalls.filter((c) => c.user.includes("鸽王"));
		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.system).toContain("帮用户关注 B 站等平台上的 UP 主");
		expect(call?.user).toContain("以下是我订阅的 2 位 UP 主近 7 天的数据");
		expect(call?.user).not.toContain("B 站 UP 主");
		const table = JSON.parse(call?.user.split("\n")[1] ?? "[]") as Array<Record<string, unknown>>;
		const profileName = (await extSub())?.cachedProfile?.name;
		expect(profileName).toMatch(/^假名字 · 第 2 版/);
		const pick = (r: Record<string, unknown>) => [r.名称, r.平台, r.投稿, r.动态, r.直播场次];
		expect(table.map(pick).sort()).toEqual(
			[
				["UID 101", "B 站", 1, 1, 1],
				[profileName, "假源", 1, 0, 0],
			].sort(),
		);

		expect(res.status, JSON.stringify(body)).toBe(200);
		expect(body.result?.pigeon.subscriptionId).toBe(S_BILI);
		expect(body.result?.diligent.subscriptionId).toBe(S_EXT);
		expect(body.result?.scores.map((s) => s.subscriptionId).sort()).toEqual([S_BILI, S_EXT].sort());
	}, 15_000);

	it("拓展订阅的单人锐评「试一次」:按订阅 id 跑,出卡的头像是存下的那张内嵌图(不是面板的相对地址),发到它自己配的目标", async () => {
		const rendersBefore = renderedHtml.length;
		const res = await api(`/api/stats/roast/run-now/${S_EXT}`, { method: "POST" });
		const body = (await res.json()) as StatsRoastRunNowResponse;
		expect(res.status, JSON.stringify(body)).toBe(200);
		expect(body).toEqual({
			ok: true,
			outcome: { kind: "sent", mode: "image", sent: 1, skipped: [], failed: [] },
		});

		const solo = aiCalls.filter((c) => c.user.includes("一位 UP 主"));
		expect(solo).toHaveLength(1);
		const data = JSON.parse(solo[0]?.user.split("\n")[1] ?? "{}") as Record<string, unknown>;
		expect(data).toMatchObject({
			名称: (await extSub())?.cachedProfile?.name,
			平台: "假源",
			投稿: 1,
		});

		await vi.waitFor(() => expect(hooks).toHaveLength(1), { timeout: 3_000, interval: 50 });
		expect(hooks[0]).toMatchObject({
			targetId: webhookTarget,
			payload: { kind: "image", caption: "这位本周还算勤快", image: { mime: "image/jpeg" } },
		});

		// 卡上的头像:资料报来的那张存下的文件,转成内嵌图。
		const avatarPath = (await extSub())?.cachedProfile?.avatar ?? "";
		const avatar = Buffer.from(await (await api(avatarPath)).arrayBuffer());
		expect(avatar.length).toBeGreaterThan(0);
		const html = renderedHtml.slice(rendersBefore).join("\n");
		expect(html).toContain(`data:image/png;base64,${avatar.toString("base64")}`);
		expect(html).not.toContain("/api/subs/");
		// 颜色与面板同一个算法(按人)。
		expect(html).toContain(upColor({ extensionId: FAKE, externalId: EXT_ID }));
	}, 15_000);

	it("停用拓展那位:首页粉丝面板撤下它,盘上的文件都留着(决策 10)", async () => {
		await ok(await api(`/api/subs/${S_EXT}`, { method: "PATCH", ...json({ enabled: false }) }));
		await vi.waitFor(
			async () => {
				await ok(
					await api("/api/dev/run/fans.poll-now", { method: "POST", ...json({ params: {} }) }),
				);
				const { entries } = (await (await api("/api/fans")).json()) as FansResponse;
				expect(entries).toEqual([]);
			},
			{ timeout: 3_000, interval: 100 },
		);
		for (const path of [
			["fans", `${S_EXT}.jsonl`],
			["stats", "seen", `${S_EXT}.jsonl`],
			["stats", "dyn", `${S_EXT}.jsonl`],
		]) {
			expect(await exists(...path), path.join("/")).toBe(true);
		}
	}, 15_000);

	it("删掉两位:各自按订阅 id 命名的文件都删掉", async () => {
		for (const id of [S_EXT, S_BILI]) {
			const res = await api(`/api/subs/${id}`, { method: "DELETE" });
			expect(res.status).toBe(204);
		}
		const files = [
			["fans", `${S_EXT}.jsonl`],
			["stats", "seen", `${S_EXT}.jsonl`],
			["stats", "dyn", `${S_EXT}.jsonl`],
			["fans", `${S_BILI}.jsonl`],
			["stats", "dyn", `${S_BILI}.jsonl`],
			["stats", "live", `${S_BILI}.jsonl`],
		];
		await vi.waitFor(
			async () => {
				const left = [];
				for (const path of files) if (await exists(...path)) left.push(path.join("/"));
				expect(left).toEqual([]);
			},
			{ timeout: 3_000, interval: 50 },
		);
	}, 15_000);
});
