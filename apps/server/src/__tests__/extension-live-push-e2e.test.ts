/**
 * 🔴 **拓展报的开播 / 下播,在真 BN 上真的推出去了**(ADR-0019 决策 56–58 / 61 / 67)。
 *
 * 直播从拓展到群里要过:ctx 核形状、对订阅 → bus 上的 `subscription-reported` → 拓展直播的计时器(记下这一场、
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
	ExtensionLookupResponse,
	ExtensionsResponse,
	HistoryResponse,
} from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";
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
	let handle: StandaloneServerHandle | undefined;
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
	/** 一条 webhook 里的文字段(卡 + 文案 + 链接合成一条时,文案与链接在同一段里)。 */
	const textOf = (hook: Hook | undefined) =>
		hook?.payload.segments?.find((seg) => seg.type === "text")?.text;

	beforeAll(async () => {
		hookServer = createHttpServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				hooks.push({ ...(JSON.parse(body) as Hook), key: req.url?.split("/").pop() ?? "" });
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
		await ok(
			await api("/api/globals", {
				method: "PATCH",
				...json({ extensions: { [FAKE]: { enabled: true } } }),
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
						kind: "direct",
						connector: "webhook",
						platform: "generic",
						config: { url: `${hookUrl}/${key}`, headers: {} },
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
		const looked = await api(`/api/ext/${FAKE}/lookup?q=${encodeURIComponent("直播探针")}`);
		await ok(looked);
		const { candidates } = (await looked.json()) as ExtensionLookupResponse;
		for (const [i, key] of KEYS.entries()) {
			const candidate = candidates[i];
			if (!candidate) throw new Error("解析门少交了候选");
			who[key] = { externalId: candidate.id, name: candidate.name, target: targetOf(key) };
			const { id: _id, ...profile } = candidate;
			const base = makeExtensionSubscription({
				id: SUBS[key].id,
				extensionId: FAKE,
				externalId: candidate.id,
			});
			await ok(
				await api("/api/subs", {
					method: "POST",
					...json({
						...base,
						routing: { ...base.routing, live: [who[key].target], liveEnd: [who[key].target] },
						cachedProfile: profile,
					}),
				}),
			);
		}
		expect(candidates[0]?.fans).toBeGreaterThan(0);
		expect(candidates[1]?.fans).toBeUndefined();
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
			const [atAll, hook] = hooksFor(key);
			// 开播是唯一允许 @全体 的那一种(与 B 站同一张映射):推送层先单发一条 @全体,再发卡。
			expect(atAll?.payload.segments?.map((seg) => seg.type)).toEqual(["at-all"]);
			expect(hook?.payload.kind).toBe("composite");
			expect(hook?.payload.segments?.[0]).toMatchObject({
				type: "image",
				mime: "image/jpeg",
				data: CARD_BYTES.toString("base64"),
			});
		}
		// 链接是事件的直播间地址(决策 77)。
		const link = "https://live\\.fake-source\\.invalid/[0-9a-f]{12}";
		expect(textOf(hooksFor("a")[1])).toMatch(
			new RegExp(`^${escapeRe(who.a.name)} 开播啦，当前粉丝数：\\S+\\n${link}$`),
		);
		expect(textOf(hooksFor("b")[1])).toMatch(
			new RegExp(`^${escapeRe(who.b.name)} 开播啦，当前粉丝数：\\n${link}$`),
		);

		// 卡是照事件画的:标题、分区、封面(字节转成 data URL)。
		const card = renderedHtml.find(
			(html) => html.includes(who.a.name) && html.includes("假直播 · 第 1 场"),
		);
		expect(card, "甲那张开播卡没画出来").toBeDefined();
		expect(card).toMatch(/data:image\/png;base64,/);
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
			expect(hooksFor(key)[2]?.payload.segments?.[0]?.type).toBe("image");
		}
		// 甲这场资料没变:粉丝变化 0;乙开播时没有粉丝数:那一格空着(决策 56)。
		expect(textOf(hooksFor("a")[2])).toMatch(
			new RegExp(`^${escapeRe(who.a.name)} 下播啦，本次直播了 \\S+，粉丝变化 0\\n`),
		);
		expect(textOf(hooksFor("b")[2])).toMatch(
			new RegExp(`^${escapeRe(who.b.name)} 下播啦，本次直播了 \\S+，粉丝变化 \\n`),
		);
	}, 15_000);

	it("历史:每条订阅一行开播、一行下播,都是拓展行(带拓展 id 与外部 id、名字快照、已送达)", async () => {
		const res = await api("/api/history?limit=50");
		await ok(res);
		const { entries } = (await res.json()) as HistoryResponse;
		for (const key of KEYS) {
			const rows = entries.filter((e) => e.subscriptionId === SUBS[key].id);
			expect(rows.map((row) => row.kind).sort()).toEqual(["live", "live-end"]);
			for (const row of rows) {
				expect(row).toMatchObject({
					status: "delivered",
					extensionId: FAKE,
					externalId: who[key].externalId,
					targetId: who[key].target,
					unameSnapshot: who[key].name,
				});
				expect(row.uid).toBeUndefined();
			}
		}
	});
});

/** 名字里的括号、点当正则用要转义(乙的名字带「(小号 · 不报粉丝)」)。 */
function escapeRe(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
