/**
 * 🔴 **拓展报的开播 / 下播,在真 BN 上真的推出去了**(ADR-0019 决策 56–58 / 61 / 67)。
 *
 * 直播从拓展到群里要过:ctx 核形状、对订阅 → 来源上下文 → 场次引擎(记下这一场、
 * 取作者、套文案)→ 与 B 站同一份的直播装配(出卡、按版式分组)→ 按订阅 id 绑好的发送(特性键照 B 站的映射)
 * → 推送层(开关、路由)→ 平台 → 历史。零件各有单元测试,但**零件全绿证明不了接上了**:计时器没注册、发送
 * 绑错了特性,症状都是开播卡一张都推不出去,而没人报错。
 *
 * 所以装假源的构建产物、起一台真 BN(与作品那条 e2e 同一套:本地 webhook 当推送目标、假浏览器出卡),经解析门
 * 建两条订阅:甲的资料里有粉丝数,乙没有(拓展没报过资料 → 粉丝那一格空着,决策 56)。面板上按「开播」「下播」,
 * 再从 webhook、卡片 HTML 与历史三处看结果。断流接续与周期推送要推时间,在计时器的模块测试里钉。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CreatorsResponse,
	ExtensionsResponse,
	HistoryResponse,
	SettingsResponse,
	SubscriptionView,
} from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { installRepoExtensionInto } from "./support/install-repo-extension.js";

/** 假浏览器:截图恒交这串字节,灌进去的每一份 HTML 留下来。 */
const CARD_BYTES = Buffer.from("fake-card-jpeg");
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
		// 适配层给每一页开请求闸(只放行 data:);替身页不发请求,两样都是空操作。
		on: () => {},
		setRequestInterception: async () => {},
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
/** 每条订阅一条 webhook 连接(webhook 的目标由连接自动带出来一个),地址的最后一截是订阅的键。 */
const SUBS = {
	a: {
		id: "e9000000-0000-4000-8000-000000000001",
		connection: "e9000000-0000-4000-8000-00000000c001",
	},
	b: {
		id: "e9000000-0000-4000-8000-000000000002",
		connection: "e9000000-0000-4000-8000-00000000c002",
	},
} as const;
type Key = keyof typeof SUBS;
const KEYS = ["a", "b"] as const;

/** webhook(通用 JSON)收到的一条,外加它打到的是哪条订阅的地址。 */
interface Hook {
	key: string;
	targetId: string;
	payload: {
		kind: string;
		text?: string;
		segments?: Array<{ type: string; text?: string; mime?: string; data?: string }>;
	};
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

describe("拓展直播 e2e:假源报开播 / 下播 → 出卡、按版式推到目标、落历史", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;
	let port: number;
	let hookServer: Server;
	let hookUrl: string;
	const hooks: Hook[] = [];
	/** 两条订阅对上的候选(名字、外部 id)与各自的推送目标。 */
	const who = {} as Record<Key, { externalId: string; name: string; target: string }>;

	const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
	const json = (body: unknown): RequestInit => ({
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	async function ok(res: Response): Promise<void> {
		expect(res.status, await res.clone().text()).toBe(200);
	}

	const hooksFor = (key: Key) => hooks.filter((h) => h.key === key);
	/** 这条里有没有 @全体 段。 */
	const hasAtAll = (hook: Hook) =>
		hook.payload.segments?.some((seg) => seg.type === "at-all") ?? false;
	/** @全体 之外的那几条(卡 + 文案 + 链接),按收到的先后:先开播、后下播。 */
	const cardsFor = (key: Key) => hooksFor(key).filter((h) => !hasAtAll(h));

	/**
	 * 对端先收到卡、后收到 @全体:推送层对 @全体 只保证先**发起**、不等它的结果(docs/agents/push.md ④),
	 * 两条走两个独立的请求,负载重时到达就是这个先后(全量跑偶发红过)。所以每条 @全体 都扣到同一地址又收到
	 * 一条别的才记下,把这个先后做成每次都有;别的那条迟迟不来(推送层哪天改成等 @全体)最多扣 1 秒。
	 */
	async function holdAtAllUntilNextHook(key: string): Promise<void> {
		const seen = hooks.filter((h) => h.key === key).length;
		const deadline = Date.now() + 1_000;
		while (Date.now() < deadline && hooks.filter((h) => h.key === key).length === seen) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	/** 一条 webhook 里的文字段(卡 + 文案 + 链接合成一条时,文案与链接在同一段里)。 */
	const textOf = (hook: Hook | undefined) =>
		hook?.payload.segments?.find((seg) => seg.type === "text")?.text;

	beforeAll(async () => {
		hookServer = createHttpServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", async () => {
				const hook = { ...(JSON.parse(body) as Hook), key: req.url?.split("/").pop() ?? "" };
				if (hasAtAll(hook)) await holdAtAllUntilNextHook(hook.key);
				hooks.push(hook);
				res.writeHead(200, { "content-type": "application/json" }).end("{}");
			});
		});
		await new Promise<void>((resolve) => hookServer.listen(0, "127.0.0.1", resolve));
		const address = hookServer.address();
		if (!address || typeof address === "string") throw new Error("webhook 没起来");
		hookUrl = `http://127.0.0.1:${address.port}/hook`;

		dataDir = await mkdtemp(join(tmpdir(), "bn-extension-live-e2e-"));
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
			// 配了浏览器才有出卡的渲染器;真正起来的是上面那个假浏览器。
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1", BN_CHROME_PATH: "/fake/chrome" },
		});
		await ok(
			await api("/api/settings", {
				method: "PATCH",
				...json({ core: { extensions: { [FAKE]: { enabled: true } } } }),
			}),
		);
		const listed = (await (await api("/api/ext")).json()) as ExtensionsResponse;
		expect(listed.extensions.find((e) => e.id === FAKE)?.state).toBe("running");

		for (const key of KEYS) {
			await ok(
				await api("/api/connections", {
					method: "POST",
					...json({
						id: SUBS[key].connection,
						name: `本地 webhook ${key}`,
						enabled: true,
						adapterKey: "webhook",
						platform: "generic",
						settings: { url: `${hookUrl}/${key}`, headers: {} },
					}),
				}),
			);
		}
		const targets = (await (await api("/api/targets")).json()) as Array<{
			id: string;
			connectionId: string;
		}>;
		const targetOf = (key: Key) => {
			const found = targets.find((t) => t.connectionId === SUBS[key].connection);
			if (!found) throw new Error(`连接 ${key} 没带出目标`);
			return found.id;
		};

		// 面板那条路建订阅:先问解析门,拿候选建。假源的头一个候选报了粉丝数,第二个没报。
		const looked = await api(`/api/sources/${FAKE}/creators?q=${encodeURIComponent("直播探针")}`);
		await ok(looked);
		const { candidates } = (await looked.json()) as CreatorsResponse;
		for (const [i, key] of KEYS.entries()) {
			const candidate = candidates[i];
			if (!candidate) throw new Error("解析门少交了候选");
			who[key] = { externalId: candidate.externalId, name: candidate.name, target: targetOf(key) };
			const { externalId: _id, ...profile } = candidate;
			const base = makeExtensionSubscription({
				id: SUBS[key].id,
				extensionId: FAKE,
				externalId: candidate.externalId,
			});
			await ok(
				await api("/api/subscriptions", {
					method: "POST",
					...json({
						...base,
						routing: { ...base.routing, liveStart: [who[key].target], liveEnd: [who[key].target] },
						cachedProfile: profile,
					}),
				}),
			);
		}
		expect(candidates[0]?.followers).toBeGreaterThan(0);
		expect(candidates[1]?.followers).toBeUndefined();
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await new Promise<void>((resolve) => hookServer.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
	});

	it("按「开播」:两条订阅各收到 @全体 + 一条开播(卡 + 文案 + 链接);甲的文案带粉丝数,乙的那一格空着", async () => {
		await ok(await api(`/api/ext/${FAKE}/actions/report.liveStart`, { method: "POST" }));
		await vi.waitFor(
			() => {
				expect(hooksFor("a")).toHaveLength(2);
				expect(hooksFor("b")).toHaveLength(2);
			},
			{ timeout: 10_000 },
		);

		for (const key of KEYS) {
			// 开播是唯一允许 @全体 的那一种(与 B 站同一张映射):推送层单发一条 @全体,另发卡。推送层只保证
			// @全体 先发起,对端收到的先后不保证(见 `holdAtAllUntilNextHook`),所以按内容认、不按位置取。
			const atAlls = hooksFor(key).filter(hasAtAll);
			expect(atAlls.map((h) => h.payload.segments?.map((seg) => seg.type))).toEqual([["at-all"]]);
			const [hook] = cardsFor(key);
			expect(hook?.payload.kind).toBe("composite");
			expect(hook?.payload.segments?.[0]).toMatchObject({
				type: "image",
				mime: "image/jpeg",
				data: CARD_BYTES.toString("base64"),
			});
		}
		// 链接是事件的直播间地址(决策 77)。
		const link = "https://live\\.fake-source\\.invalid/[0-9a-f]{12}";
		expect(textOf(cardsFor("a")[0])).toMatch(
			new RegExp(`^${escapeRe(who.a.name)} 开播啦，当前粉丝数：\\S+\\n${link}$`),
		);
		expect(textOf(cardsFor("b")[0])).toMatch(
			new RegExp(`^${escapeRe(who.b.name)} 开播啦，当前粉丝数：\\n${link}$`),
		);

		// 卡是照事件画的:标题、分区、封面。封面与事件头像的字节出卡前存进图库(`liveImages`),卡输入里只放引用,
		// 出图器经 `resolveImageRef` 读回来转成 data URL —— 三处接线断一处,这里封面就是占位。
		const card = renderedHtml.find(
			(html) => html.includes(who.a.name) && html.includes("假直播 · 第 1 场"),
		);
		expect(card, "甲那张开播卡没画出来").toBeDefined();
		expect(card).toMatch(/src="data:image\/png;base64,[^"]+" alt="封面"/);
	}, 15_000);

	it("按「下播」(断流接续默认关着):立刻各收到一条下播(不 @全体),文案带这一场的时长", async () => {
		await ok(await api(`/api/ext/${FAKE}/actions/report.liveEnd`, { method: "POST" }));
		await vi.waitFor(
			() => {
				expect(hooksFor("a")).toHaveLength(3);
				expect(hooksFor("b")).toHaveLength(3);
			},
			{ timeout: 10_000 },
		);
		for (const key of KEYS) {
			// 下播不 @全体:@全体 仍只有开播那一条。
			expect(hooksFor(key).filter(hasAtAll)).toHaveLength(1);
			expect(cardsFor(key)[1]?.payload.segments?.[0]?.type).toBe("image");
		}
		// 甲这场资料没变:粉丝变化 0;乙开播时没有粉丝数:那一格空着(决策 56)。
		expect(textOf(cardsFor("a")[1])).toMatch(
			new RegExp(`^${escapeRe(who.a.name)} 下播啦，本次直播了 \\S+，粉丝变化 0\\n`),
		);
		expect(textOf(cardsFor("b")[1])).toMatch(
			new RegExp(`^${escapeRe(who.b.name)} 下播啦，本次直播了 \\S+，粉丝变化 \\n`),
		);
	}, 15_000);

	it("历史:每条订阅一行开播、一行下播,都是拓展行(带拓展 id 与外部 id、名字快照、已送达)", async () => {
		// 历史在 BN 收到 webhook 的回复**之后**才落盘,而上一条用例等的是 webhook 收到消息 —— 负载重时
		// 直接读会读早(全量跑偶发红),所以等它到齐。
		await vi.waitFor(
			async () => {
				const res = await api("/api/history?limit=50");
				await ok(res);
				const { entries } = (await res.json()) as HistoryResponse;
				for (const key of KEYS) {
					const rows = entries.filter((e) => e.subscriptionId === SUBS[key].id);
					expect(rows.map((row) => row.feature).sort()).toEqual(["liveEnd", "liveStart"]);
					for (const row of rows) {
						expect(row).toMatchObject({
							status: "delivered",
							identity: { sourceKey: FAKE, externalId: who[key].externalId },
							targetId: who[key].target,
							nameSnapshot: who[key].name,
						});
					}
				}
			},
			{ timeout: 10_000 },
		);
	}, 15_000);

	it("同一服务切换四语后，下一场直播用当前默认模板和卡片标签，已送达历史保持原文", async () => {
		const readHistory = async () => {
			const response = await api("/api/history?limit=50");
			await ok(response);
			return ((await response.json()) as HistoryResponse).entries;
		};
		let protectedRows = await readHistory();
		expect(protectedRows).toHaveLength(4);

		for (const [locale, start, end, durationTail, liveLabel, endLabel] of [
			[
				"en",
				" is live. Current followers: ",
				" ended the stream. Duration: ",
				". Follower change: ",
				"Live",
				"Ended",
			],
			[
				"ja",
				"が配信を開始しました。現在のフォロワー数：",
				"の配信が終了しました。配信時間：",
				"、フォロワー増減：",
				"配信中",
				"配信終了",
			],
			[
				"zh-TW",
				" 開播了，目前粉絲數：",
				" 已結束直播，本次直播時長 ",
				"，粉絲增減 ",
				"直播中",
				"已結束直播",
			],
			["zh-CN", " 开播啦，当前粉丝数：", " 下播啦，本次直播了 ", "，粉丝变化 ", "直播中", "已下播"],
		] as const) {
			await ok(
				await api("/api/settings", {
					method: "PATCH",
					...json({ core: { locale, voice: locale === "en" ? "plain" : "maid" } }),
				}),
			);
			const settings = (await (await api("/api/settings")).json()) as SettingsResponse;
			expect(settings.core.defaults.templates).not.toHaveProperty("liveStart");
			expect(settings.core.defaults.templates).not.toHaveProperty("liveEnd");
			const seenCards = Object.fromEntries(KEYS.map((key) => [key, cardsFor(key).length]));
			let seenHtml = renderedHtml.length;
			await ok(await api(`/api/ext/${FAKE}/actions/report.liveStart`, { method: "POST" }));
			await vi.waitFor(
				() => {
					for (const key of KEYS) expect(cardsFor(key)).toHaveLength((seenCards[key] ?? 0) + 1);
				},
				{ timeout: 10_000 },
			);
			for (const key of KEYS) {
				const text = textOf(cardsFor(key).at(-1));
				expect(text).toMatch(
					new RegExp(
						`^${escapeRe(who[key].name + start)}${key === "a" ? "\\S+" : ""}\\nhttps://live\\.fake-source\\.invalid/[0-9a-f]{12}$`,
					),
				);
				const html = renderedHtml.slice(seenHtml).find((card) => card.includes(who[key].name));
				expect(html).toContain(`>${liveLabel}<`);
				expect(html).toContain("假直播 · 第 ");
			}
			seenHtml = renderedHtml.length;
			await ok(await api(`/api/ext/${FAKE}/actions/report.liveEnd`, { method: "POST" }));
			await vi.waitFor(
				() => {
					for (const key of KEYS) expect(cardsFor(key)).toHaveLength((seenCards[key] ?? 0) + 2);
				},
				{ timeout: 10_000 },
			);
			for (const key of KEYS) {
				const text = textOf(cardsFor(key).at(-1));
				expect(text).toMatch(
					new RegExp(
						`^${escapeRe(who[key].name + end)}.+${escapeRe(durationTail)}${key === "a" ? "0" : ""}\\nhttps://live\\.fake-source\\.invalid/[0-9a-f]{12}$`,
					),
				);
				const html = renderedHtml.slice(seenHtml).find((card) => card.includes(who[key].name));
				expect(html).toContain(`>${endLabel}<`);
			}
			await vi.waitFor(
				async () => {
					const rows = await readHistory();
					expect(rows).toHaveLength(KEYS.reduce((count, key) => count + cardsFor(key).length, 0));
					for (const original of protectedRows)
						expect(rows.find((row) => row.id === original.id)).toEqual(original);
					for (const key of KEYS) {
						const latest = rows.filter((row) => row.subscriptionId === SUBS[key].id).slice(0, 2);
						expect(latest.map((row) => row.feature).sort()).toEqual(["liveEnd", "liveStart"]);
						for (const row of latest) {
							expect(row).toMatchObject({ status: "delivered", nameSnapshot: who[key].name });
							expect(row.messages.find((message) => message.role === "main")?.text).toBe(
								textOf(cardsFor(key).at(row.feature === "liveStart" ? -2 : -1)),
							);
						}
					}
				},
				{ timeout: 10_000 },
			);
			protectedRows = await readHistory();
		}
	}, 30_000);

	it("切换语言不改全局手写模板或订阅覆盖，发送时仍先用订阅的文字", async () => {
		await ok(
			await api("/api/settings", {
				method: "PATCH",
				...json({
					core: { defaults: { templates: { liveStart: "Global original 原文: {name}" } } },
				}),
			}),
		);
		await ok(
			await api(`/api/subscriptions/${SUBS.a.id}`, {
				method: "PATCH",
				...json({ overrides: { templates: { liveStart: "Subscription original 原文: {name}" } } }),
			}),
		);
		for (const locale of ["ja", "en"] as const) {
			await ok(await api("/api/settings", { method: "PATCH", ...json({ core: { locale } }) }));
			const seen = Object.fromEntries(KEYS.map((key) => [key, cardsFor(key).length]));
			await ok(await api(`/api/ext/${FAKE}/actions/report.liveStart`, { method: "POST" }));
			await vi.waitFor(
				() => {
					for (const key of KEYS) expect(cardsFor(key)).toHaveLength((seen[key] ?? 0) + 1);
				},
				{ timeout: 10_000 },
			);
			for (const key of KEYS) {
				const prefix = key === "a" ? "Subscription original 原文: " : "Global original 原文: ";
				expect(textOf(cardsFor(key).at(-1))).toMatch(
					new RegExp(
						`^${escapeRe(prefix + who[key].name)}\\nhttps://live\\.fake-source\\.invalid/[0-9a-f]{12}$`,
					),
				);
			}
			const settings = (await (await api("/api/settings")).json()) as SettingsResponse;
			expect(settings.core.defaults.templates.liveStart).toBe("Global original 原文: {name}");
			const subscriptions = (await (await api("/api/subscriptions")).json()) as SubscriptionView[];
			expect(
				subscriptions.find((sub) => sub.id === SUBS.a.id)?.overrides.templates?.liveStart,
			).toBe("Subscription original 原文: {name}");
			expect(
				subscriptions.find((sub) => sub.id === SUBS.b.id)?.overrides.templates?.liveStart,
			).toBeUndefined();
			await ok(await api(`/api/ext/${FAKE}/actions/report.liveEnd`, { method: "POST" }));
			await vi.waitFor(
				() => {
					for (const key of KEYS) expect(cardsFor(key)).toHaveLength((seen[key] ?? 0) + 2);
				},
				{ timeout: 10_000 },
			);
		}
	}, 15_000);
});

/** 名字里的括号、点当正则用要转义(乙的名字带「(小号 · 不报粉丝)」)。 */
function escapeRe(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
