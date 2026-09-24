/**
 * 🔴 **拓展报的作品,在真 BN 上真的推出去了**(ADR-0019 决策 66 / 69–72 / 77)。
 *
 * 作品从拓展到群里要过:ctx 核形状、对订阅 → bus 上的 `subscription-reported` → 作品的消费者(过滤、
 * 取作者、翻成中立作品)→ 与 B 站同一份的装配(出卡、套模板、按版式分组)→ 按订阅 id 绑好的发送 →
 * 推送层(开关、路由)→ 平台 → 历史。零件各有单元测试,但**零件全绿证明不了接上了**:消费者没注册、
 * 发送绑错了订阅,症状都是作品一条都推不出去,而没人报错。
 *
 * 所以装假源的构建产物、起一台真 BN:经解析门建三条订阅,推送目标是一个本地的 webhook(通用 JSON,
 * 收到什么记什么),出卡的浏览器换成假的(截图交一串固定字节、灌进去的 HTML 留下来看)。面板上按
 * 「报一条作品」,再从 webhook、卡片 HTML 与历史三处看结果。
 *
 * - 甲:开着,什么都不拦 —— 图文、视频两条都收到,照默认版式(卡 + 文案 + 链接一条)。
 * - 乙:开着,按 UP 屏蔽「图文」—— 第一条(图文)被挡,第二条(视频)照收。
 * - 丙:停用 —— 什么都收不到(决策 62)。
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
		id: "e8000000-0000-4000-8000-000000000001",
		connection: "e8000000-0000-4000-8000-00000000c001",
	},
	b: {
		id: "e8000000-0000-4000-8000-000000000002",
		connection: "e8000000-0000-4000-8000-00000000c002",
	},
	c: {
		id: "e8000000-0000-4000-8000-000000000003",
		connection: "e8000000-0000-4000-8000-00000000c003",
	},
} as const;
type Key = keyof typeof SUBS;
const KEYS = ["a", "b", "c"] as const;

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

describe("拓展作品 e2e:假源报一条作品 → 过滤、出卡、按版式推到目标、落历史", () => {
	let dataDir: string;
	let handle: StandaloneServerHandle | undefined;
	let port: number;
	let hookServer: Server;
	let hookUrl: string;
	const hooks: Hook[] = [];
	/** 三条订阅对上的候选(名字、外部 id)与各自的推送目标。 */
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

		dataDir = await mkdtemp(join(tmpdir(), "bn-extension-post-e2e-"));
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

		// 推送目标:每条订阅一条 webhook 连接,它的目标由连接自动带出来。
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

		// 面板那条路建订阅:先问解析门,拿候选建。
		const looked = await api(`/api/ext/${FAKE}/lookup?q=${encodeURIComponent("作品探针")}`);
		await ok(looked);
		const { candidates } = (await looked.json()) as ExtensionLookupResponse;
		expect(candidates).toHaveLength(3);
		for (const [i, key] of KEYS.entries()) {
			const candidate = candidates[i];
			if (!candidate) throw new Error("解析门少交了候选");
			who[key] = { externalId: candidate.id, name: candidate.name, target: targetOf(key) };
			const { id: _id, ...profile } = candidate;
			const base = makeExtensionSubscription({
				id: SUBS[key].id,
				extensionId: FAKE,
				externalId: candidate.id,
				enabled: key !== "c",
			});
			await ok(
				await api("/api/subs", {
					method: "POST",
					...json({
						...base,
						routing: { ...base.routing, dynamic: [who[key].target] },
						// 乙按 UP 屏蔽「图文」:第一条作品(图文)正文里有这两个字。
						overrides:
							key === "b"
								? { ...base.overrides, filters: { blockKeywords: ["图文"] } }
								: base.overrides,
						cachedProfile: profile,
					}),
				}),
			);
		}
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await new Promise<void>((resolve) => hookServer.close(() => resolve()));
		await rm(dataDir, { recursive: true, force: true });
	});

	it("报一条图文、一条视频:甲收到卡 + 文案 + 链接各两条;乙只收到视频(图文被屏蔽词挡下);停用的丙什么都没有", async () => {
		await ok(await api(`/api/ext/${FAKE}/actions/report.post`, { method: "POST" }));
		await ok(await api(`/api/ext/${FAKE}/actions/report.post`, { method: "POST" }));

		// 乙的两条排在同一道闸里:等到它的第二条(视频)到了,第一条(图文)要是没被挡,早该先到了。
		await vi.waitFor(
			() => {
				expect(hooksFor("a")).toHaveLength(2);
				expect(hooksFor("b")).toHaveLength(1);
			},
			{ timeout: 10_000 },
		);

		const [first, second] = hooksFor("a");
		for (const [hook, template, n] of [
			[first, "发布了一条动态", 1],
			[second, "发布了新视频", 2],
		] as const) {
			// 默认版式:卡片 + 文案 + 链接合成一条;链接是事件的 url(决策 77),文案的 {name} 取资料名。
			expect(hook?.payload.kind).toBe("composite");
			const [image, text] = hook?.payload.segments ?? [];
			expect(image).toMatchObject({
				type: "image",
				mime: "image/jpeg",
				data: CARD_BYTES.toString("base64"),
			});
			expect(text?.type).toBe("text");
			expect(text?.text).toMatch(
				new RegExp(
					`^${who.a.name}${template}\\nhttps://fake-source\\.invalid/[0-9a-f]{12}/post/${n}$`,
				),
			);
		}

		const [onlyB] = hooksFor("b");
		expect(onlyB?.payload.segments?.[1]?.text).toMatch(/发布了新视频\nhttps:\/\/.+\/post\/2$/);
		expect(hooksFor("c")).toEqual([]);
	}, 15_000);

	it("卡是照作品画的:作者名与存下的头像(转成 data URL)、正文、九宫格里的图都在卡上", async () => {
		const avatar = await api(`/api/subs/${SUBS.a.id}/avatar`);
		expect(avatar.status).toBe(200);
		const avatarDataUrl = `data:${avatar.headers.get("content-type")};base64,${Buffer.from(
			await avatar.arrayBuffer(),
		).toString("base64")}`;

		const card = renderedHtml.find(
			(html) => html.includes(who.a.name) && html.includes("假源的第 1 条作品"),
		);
		expect(card, "甲那张图文卡没画出来").toBeDefined();
		expect(card).toContain(avatarDataUrl);
		// 头像是面板的相对地址那种的话,截图时加载不到(决策 68)。
		expect(card).not.toContain(`/api/subs/${SUBS.a.id}/avatar`);
		// 三张作品图都转成了 data URL 进卡。
		expect(card?.match(/data:image\/png;base64,/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
	});

	it("历史:甲两行拓展行(带拓展 id 与外部 id、名字快照、已送达),乙一行,丙没有", async () => {
		const res = await api("/api/history?limit=50");
		await ok(res);
		const { entries } = (await res.json()) as HistoryResponse;
		const rowsOf = (key: Key) => entries.filter((e) => e.subscriptionId === SUBS[key].id);
		expect(rowsOf("a")).toHaveLength(2);
		for (const row of rowsOf("a")) {
			expect(row).toMatchObject({
				kind: "dynamic",
				status: "delivered",
				extensionId: FAKE,
				externalId: who.a.externalId,
				targetId: who.a.target,
				unameSnapshot: who.a.name,
			});
			expect(row.uid).toBeUndefined();
		}
		expect(rowsOf("b")).toHaveLength(1);
		expect(rowsOf("c")).toEqual([]);
	});
});
