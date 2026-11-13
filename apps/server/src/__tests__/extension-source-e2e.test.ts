/**
 * 🔴 **第 3 版的拓展订阅源,在真 BN 上经来源登记表跑通**(3b-42):拓展 `ctx.registerSource` 登记 → 装载器等登记落定
 * → 来源登记表 → 来源上下文 → 作品入口 / 场次引擎 / 资料写口。零件各有单元测试,但**零件全绿证明不了接上了**:
 * 装载器没递 `registerSource`、引擎没把拓展的来源登进表、作者名补链没接,症状都是拓展那头照样「报上去了」,
 * 而首页、历史、订阅页上什么都没有,没人报错。
 *
 * 所以装一个真的最小订阅源拓展进装载根(测试里写出来的 `index.mjs`,不是仓里的拓展包)、起一台真 BN:
 * 面板按它的动作钮报 —— 一条作品(进推送截流,恰好一条)、一条开播(在播表里有它,开播时刻统一成 UTC ISO)、
 * 一条资料(订阅页的资料缓存变了)、一条多了一格的坏作品(上报出入多一条拒收)。另一个拓展的 `start` 抛了:
 * 它在拓展列表里是加载失败,原因在。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	DevCapturedDelivery,
	ExtensionsResponse,
	LiveListeningEntry,
	SubscriptionView,
} from "@bilibili-notify/contract";
import { ImageRenderer } from "@bilibili-notify/image";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { Api } from "../bilibili/api/index.js";
import { CORE_SETTINGS_FILE } from "../config/store.js";
import { type ServerHandle, startServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { activeGeneration } from "./support/generation.js";
import { deferred } from "./support/track-context.js";

const PROBE = "source-probe";
const BROKEN = "source-broken";
const LINKS = "link-probe";
const EXTERNAL = "probe-user-1";
/** 只靠拉取式(`fetchLiveStatus`)认出来的那位:探针对它回在播,从不 `reportLive`。 */
const PULLED = "probe-pulled-1";
const PULLED_SUB_ID = "e3000000-0000-4000-8000-000000000002";
const SUB_ID = "e3000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "e3000000-0000-4000-8000-00000000c001";
const TARGET_ID = "e3000000-0000-4000-8000-00000000d001";
const STARTED_AT = Date.UTC(2026, 8, 23, 12);
/** 拓展交出去的写法:带 +08:00 偏移的 ISO(与 STARTED_AT 同一刻)。 */
const STARTED_AT_WIRE = "2026-09-23T20:00:00+08:00";

/** 每个动作真调一次 `ctx` 上的上报方法;`source` 是 `start` 时拿到的那面上下文。 */
const PROBE_CODE = `
const ID = ${JSON.stringify(EXTERNAL)};
let source;
export function activate(ctx) {
	ctx.registerSource({
		start(c) { source = c; },
		stop() {},
		searchCreators: async () => ({ ok: true, candidates: [] }),
		// 清单声明了 liveStreaming,登记时核要交(周期「正在直播」只经核心问来源)。
		fetchLiveStatus: async (identity) =>
			identity.externalId === ${JSON.stringify(PULLED)}
				? { ok: true, kind: "live", startedAt: ${JSON.stringify(STARTED_AT_WIRE)}, details: { title: "问到的标题" } }
				: { ok: true, kind: "offline" },
	});
	ctx.onAction("report.post", () =>
		source.reportPost(ID, {
			postId: "p1",
			url: "https://probe.invalid/p1",
			post: { publishedAt: ${JSON.stringify(STARTED_AT_WIRE)}, text: "今天去海边" },
		}),
	);
	ctx.onAction("report.badPost", () =>
		source.reportPost(ID, {
			postId: "p2",
			url: "https://probe.invalid/p2",
			post: { publishedAt: ${JSON.stringify(STARTED_AT_WIRE)}, text: "多了一格", title: "不开放的格" },
		}),
	);
	ctx.onAction("report.liveStart", () =>
		source.reportLive(ID, {
			kind: "start",
			startedAt: ${JSON.stringify(STARTED_AT_WIRE)},
			details: { title: "开播了", category: "聊天", totalViewers: 70 },
		}),
	);
	ctx.onAction("report.profile", () =>
		source.reportProfile(ID, { name: "探针本人", followers: 123 }),
	);
}
`;

const BROKEN_CODE = `
export function activate(ctx) {
	ctx.registerSource({
		start() { throw new Error("平台连不上"); },
		stop() {},
		searchCreators: async () => ({ ok: true, candidates: [] }),
	});
}
`;

const LINK_CODE = `
export function activate(ctx) {
  const seen = [];
  ctx.mount(() => Response.json(seen));
  ctx.registerSource({
    start() {}, stop() {}, searchCreators: async () => ({ ok: true, candidates: [] }),
    async resolveLink(url, signal) {
      if (!(signal instanceof AbortSignal)) throw Error("missing cancellation");
      seen.push(url);
      const path = new URL(url).pathname;
      if (path === "/limited") return {ok: false, code: "rate_limited", message: "稍后重试"};
      if (path === "/outside") return {ok: true, postId: "outside", url: "https://elsewhere.invalid/note/1",
        post: {creator: {name: "越界作者"}, publishedAt: "2026-10-01T08:00:00Z", text: "越界"}};
      const postId = path === "/s17" ? "17" : path.split("/").pop();
      const canonical = "https://works.invalid/" + (path.startsWith("/note/") ? "note/" : "video/") + postId;
      return { ok: true, postId, url: canonical, post: { creator: { name: "未订阅作者" },
        publishedAt: "2026-10-01T08:00:00Z", text: url,
        ...(path.startsWith("/note/") ? { images: ["a".repeat(64) + ".png"] } : { video: { title: "视频作品" } }) } };
    },
  });
}
`;

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

describe("拓展订阅源 e2e:经来源登记表,上报进到推送、在播、资料与上报出入", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;
	let port: number;

	const base = () => `http://127.0.0.1:${port}`;
	const api = (path: string, init?: RequestInit) => fetch(`${base()}${path}`, init);
	const json = (body: unknown, method = "POST"): RequestInit => ({
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	async function okRes(res: Response): Promise<Response> {
		expect(res.status, await res.clone().text()).toBeLessThan(300);
		return res;
	}

	function boot(at: number): Promise<ServerHandle> {
		return startServer({
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
		});
	}

	/** 面板按一下那个动作钮。 */
	async function press(action: string): Promise<void> {
		await okRes(await api(`/api/ext/${PROBE}/actions/${action}`, { method: "POST" }));
	}

	async function extensions(): Promise<ExtensionsResponse["extensions"]> {
		const res = await okRes(await api("/api/ext"));
		return ((await res.json()) as ExtensionsResponse).extensions;
	}

	async function captures(): Promise<DevCapturedDelivery[]> {
		const res = await okRes(await api("/api/dev/captures"));
		return ((await res.json()) as { entries: DevCapturedDelivery[] }).entries;
	}

	async function patchCore(core: object) {
		await okRes(await api("/api/settings", json({ core }, "PATCH")));
	}
	async function say(text: string, address?: string) {
		await okRes(await api("/api/dev/run/core.inbound.link", json({ params: { text, address } })));
	}
	async function seen(): Promise<string[]> {
		return (await (await okRes(await api(`/ext/${LINKS}`))).json()) as string[];
	}
	async function captureLinks(replyForm: string) {
		if (replyForm !== "text") {
			await okRes(await api("/api/cards/renderer", json({ chromePath: "/fake/chrome" })));
		}
		await patchCore({
			linkPreview: { enabled: true, cooldownSec: 60, isOnByDefault: true, replyForm },
		});
		await okRes(await api("/api/dev/run/core.push.capture", json({ params: {} })));
		await okRes(await api("/api/dev/captures/clear", { method: "POST" }));
	}

	/** 同 `extension-live-e2e`:先空启动一趟拿到完整的 globals,再摆拓展、开开关,重起。 */
	beforeAll(async () => {
		vi.spyOn(ImageRenderer.prototype, "generatePostCard").mockResolvedValue(Buffer.from("card"));
		dataDir = await mkdtemp(join(tmpdir(), "bn-ext-source-e2e-"));
		const seed = await boot(await findFreePort());
		await seed.close("seed");
		const gen = await activeGeneration(dataDir);

		const globalsPath = join(gen, ...CORE_SETTINGS_FILE);
		const globals = JSON.parse(await readFile(globalsPath, "utf8")) as Record<string, unknown>;
		globals.extensions = {
			[PROBE]: { enabled: true },
			[BROKEN]: { enabled: true },
			[LINKS]: { enabled: true },
		};
		await writeFile(globalsPath, JSON.stringify(globals));

		for (const [id, name, code, actions, supportedFeatures] of [
			[
				PROBE,
				"来源探针",
				PROBE_CODE,
				["report.post", "report.badPost", "report.liveStart", "report.profile"],
				["post", "liveStart", "liveStreaming", "liveEnd"],
			],
			[BROKEN, "起不来的来源", BROKEN_CODE, undefined, ["post"]],
			[LINKS, "群聊作品", LINK_CODE, undefined, ["post"]],
		] as const) {
			const extDir = join(gen, "extensions", id);
			await mkdir(extDir, { recursive: true });
			await writeFile(
				join(extDir, "extension.json"),
				JSON.stringify({
					id,
					name,
					description: "测试用",
					version: "0.1.0",
					apiVersion: 1,
					...(id === LINKS ? { apiRevision: 1 } : {}),
					...(actions ? { actions } : {}),
					contributes: {
						...(id === LINKS
							? {
									linkResolver: {
										patterns: [
											{ host: "works.invalid", pathPrefix: "/video/" },
											{ host: "works.invalid", pathPrefix: "/note/" },
											{ host: "short.invalid", pathPrefix: "/" },
										],
									},
								}
							: {}),
						subscription: {
							label: "探针",
							shortLabel: "探",
							color: "#3366ff",
							supportedFeatures,
						},
					},
				}),
			);
			await writeFile(join(extDir, "index.mjs"), code);
		}

		port = await findFreePort();
		handle = await boot(port);

		// 推送目标:一条 OneBot(HTTP)连接,指向没人监听的回环端口 —— 截流开着时适配器的 `send` 压根不会被调到。
		await okRes(
			await api(
				"/api/connections",
				json({
					id: CONNECTION_ID,
					name: "本机回环 bot",
					enabled: true,
					adapterKey: "onebot",
					platform: "onebot",
					settings: {
						transport: "http",
						baseUrl: `http://127.0.0.1:${await findFreePort()}`,
						maxRetries: 0,
						retryIntervalMs: 0,
					},
				}),
			),
		);
		await okRes(
			await api(
				"/api/targets",
				json({
					id: TARGET_ID,
					name: "测试群",
					connectionId: CONNECTION_ID,
					kind: "session",
					scope: "group",
					address: "10001",
					enabled: true,
				}),
			),
		);
		const sub = makeExtensionSubscription({
			id: SUB_ID,
			extensionId: PROBE,
			externalId: EXTERNAL,
			enabled: true,
		});
		await okRes(
			await api(
				"/api/subscriptions",
				json({ ...sub, routing: { ...sub.routing, post: [TARGET_ID] } }),
			),
		);
	}, 30_000);

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		vi.restoreAllMocks();
		await rm(dataDir, { recursive: true, force: true });
	});

	it("两个拓展都装上了:好的在跑,start 抛了的是加载失败、原因在拓展列表里", async () => {
		const list = await extensions();
		expect(list.find((e) => e.id === PROBE)?.state).toBe("running");
		const broken = list.find((e) => e.id === BROKEN);
		expect(broken?.state).toBe("failed");
		expect(broken?.detail).toContain("平台连不上");
	});

	it("报一条作品:进推送截流,恰好一条,发到订阅路由的那个目标", async () => {
		// 开截流(devtools 的推送截流,接在派发器调适配器 `send` 的那一处,开着不出网)。
		await okRes(await api("/api/dev/run/core.push.capture", json({ params: {} })));
		await okRes(await api("/api/dev/captures/clear", { method: "POST" }));
		await press("report.post");
		await vi.waitFor(async () => expect((await captures()).length).toBeGreaterThanOrEqual(1), {
			timeout: 10_000,
		});
		// 要是重复发了,第二条会在这段时间里到。
		await new Promise((resolve) => setTimeout(resolve, 300));
		const entries = await captures();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ targetId: TARGET_ID, connectionId: CONNECTION_ID });
		// 事件没带作者名:补的是身份标签(平台名 · 外部 id),正文在推送文字里。
		expect(entries[0]?.text).toContain("探针 · probe-user-1");
	}, 15_000);

	it("报一条开播:在播表里有它,标题、分区、累计观看照搬,开播时刻统一成 UTC ISO", async () => {
		await press("report.liveStart");
		const res = await okRes(await api("/api/live/listening"));
		const entries = ((await res.json()) as LiveListeningEntry[]).filter(
			(entry) => entry.subscriptionId === SUB_ID,
		);
		expect(entries).toEqual([
			{
				subscriptionId: SUB_ID,
				identity: { sourceKey: PROBE, externalId: EXTERNAL },
				isLive: true,
				title: "开播了",
				category: "聊天",
				startedAt: new Date(STARTED_AT).toISOString(),
				totalViewers: 70,
			},
		]);
	});

	// 接线的钉子(不推时间):订阅进了监听,核心对「要监听直播、手里没场次」的订阅调来源的 `fetchLiveStatus`,
	// 在播就认出一场 —— 拓展一次 `reportLive` 都没调。去掉 `extension-source.ts` 里放 `fetchLiveStatus` 的那一格,这条红。
	it("拉取式认出一场:探针的 fetchLiveStatus 回在播、从不 reportLive → 在播表里有这一场,开播时刻统一成 UTC ISO", async () => {
		const sub = makeExtensionSubscription({
			id: PULLED_SUB_ID,
			extensionId: PROBE,
			externalId: PULLED,
			enabled: true,
		});
		await okRes(await api("/api/subscriptions", json(sub)));
		await vi.waitFor(
			async () => {
				const res = await okRes(await api("/api/live/listening"));
				const entries = (await res.json()) as LiveListeningEntry[];
				expect(entries.find((entry) => entry.subscriptionId === PULLED_SUB_ID)).toMatchObject({
					identity: { sourceKey: PROBE, externalId: PULLED },
					isLive: true,
					title: "问到的标题",
					startedAt: new Date(STARTED_AT).toISOString(),
				});
			},
			{ timeout: 10_000 },
		);
	});

	it("报一份资料:订阅页读到的资料缓存变了(名字、粉丝数)", async () => {
		await press("report.profile");
		await vi.waitFor(
			async () => {
				const subs = (await (await api("/api/subscriptions")).json()) as SubscriptionView[];
				const profile = subs.find((s) => s.id === SUB_ID)?.cachedProfile;
				expect(profile).toMatchObject({ name: "探针本人", followers: 123 });
			},
			{ timeout: 10_000 },
		);
	});

	it("报一条多了一格的坏作品:整条拒,不推送,上报出入里多一条拒收(点名那一格)", async () => {
		await okRes(await api("/api/dev/captures/clear", { method: "POST" }));
		await press("report.badPost");
		await vi.waitFor(
			async () => {
				const discrepancies = (await extensions()).find((e) => e.id === PROBE)?.reportDiscrepancies;
				expect(discrepancies?.[0]).toMatchObject({
					kind: "post",
					externalId: EXTERNAL,
					subscriptionIds: [SUB_ID],
					outcome: "rejected",
				});
				expect(discrepancies?.[0]?.reasons.join("")).toContain("post.title");
			},
			{ timeout: 10_000 },
		);
		// 拒收的那条没往推送去。
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(await captures()).toEqual([]);
	});
	it("失败拓展卸载之后,来源表与健康格都不残留伪装成内置来源的失败视图", async () => {
		await okRes(await api(`/api/ext/${BROKEN}`, { method: "DELETE" }));
		const sources = (await (await api("/api/sources")).json()) as {
			sources: Array<{ key: string }>;
		};
		const details = (await (await api("/api/health/details")).json()) as {
			integrations: Array<{ key: string }>;
		};
		expect(sources.sources.some((source) => source.key === BROKEN)).toBe(false);
		expect(details.integrations.some((integration) => integration.key === BROKEN)).toBe(false);
	});

	it("群里贴作品：已装载的拓展只接到命中的单链接，未订阅作者照样回文字", async () => {
		expect((await extensions()).find((entry) => entry.id === LINKS)?.state).toBe("running");
		await captureLinks("text");
		await say(
			"ftp://short.invalid/hidden https://short.invalid@evil.invalid/private https://short.invalid:bogus/off",
		);
		await say(
			"群里其他内容 https://works.invalid/users/private https://works.invalid.evil.invalid/video/8 works.invalid/video/17",
		);
		await vi.waitFor(async () =>
			expect(await captures()).toMatchObject([
				{
					kind: "text",
					text: expect.stringContaining("未订阅作者\nhttps://works.invalid/video/17"),
				},
			]),
		);
		await say("重复作品 https://short.invalid/s17");
		await vi.waitFor(async () =>
			expect(await seen()).toEqual(["https://works.invalid/video/17", "https://short.invalid/s17"]),
		);
		expect(await captures()).toHaveLength(1);
	});

	it("群聊图文和 B 站视频各自认领链接，原生分享回落图片，关闭的群与撤销的来源不接链接", async () => {
		const render = vi.mocked(ImageRenderer.prototype.generatePostCard);
		const video = vi.spyOn(Api.prototype, "fetchVideoInfo").mockResolvedValue({
			bvid: "BV1zMtU6uEEb",
			aid: 17,
			title: "B 站视频",
			pic: "",
			desc: "测试",
			duration: 5,
			pubdate: 1756800000,
			tname: "日常",
			owner: { mid: 1, name: "B 站作者", face: "" },
			stat: { view: 1, danmaku: 0, reply: 0, favorite: 0, coin: 0, share: 0, like: 0 },
		});
		await captureLinks("nativeShare");
		await okRes(
			await api(
				"/api/dev/run/core.connection.capability",
				json({
					params: { connection: CONNECTION_ID, state: "supported" },
				}),
			),
		);
		const before = await seen();
		await patchCore({ linkPreview: { byTarget: { [TARGET_ID]: { isOn: false } } } });
		await say("https://works.invalid/note/off");
		await patchCore({ linkPreview: { byTarget: { [TARGET_ID]: null } } });
		await say("https://short.invalid/limited https://short.invalid/outside");
		await vi.waitFor(async () => expect(await seen()).toContain("https://short.invalid/outside"));
		await say("https://works.invalid/note/18 https://www.bilibili.com/video/BV1zMtU6uEEb");
		await vi.waitFor(async () =>
			expect((await captures()).map((c) => c.kind).sort()).toEqual(["image", "native-share"]),
		);
		expect(await seen()).toEqual([
			...before,
			"https://short.invalid/limited",
			"https://short.invalid/outside",
			"https://works.invalid/note/18",
		]);
		expect(render).toHaveBeenCalledWith(
			expect.objectContaining({
				creator: { name: "未订阅作者" },
				images: [{ ref: `${"a".repeat(64)}.png` }],
			}),
			expect.anything(),
			{ priority: "low" },
		);
		expect(video).toHaveBeenCalledWith({ bvid: "BV1zMtU6uEEb" });
		await patchCore({ extensions: { [LINKS]: { enabled: false } } });
		await vi.waitFor(async () =>
			expect((await extensions()).find((e) => e.id === LINKS)?.state).toBe("disabled"),
		);
		await say("https://works.invalid/note/19 https://www.bilibili.com/video/av88", "10002");
		await vi.waitFor(() => expect(video).toHaveBeenCalledWith({ aid: "88" }));
		await vi.waitFor(async () => expect(await captures()).toHaveLength(3));
		expect(render.mock.calls.some(([post]) => post.text.endsWith("/note/19"))).toBe(false);
	});

	it("群聊作品还在出图时停用拓展，迟到的图片不会发回群", async () => {
		await patchCore({ extensions: { [LINKS]: { enabled: true } } });
		await vi.waitFor(async () =>
			expect((await extensions()).find((e) => e.id === LINKS)?.state).toBe("running"),
		);
		await captureLinks("image");
		const rendering = deferred<Buffer>();
		const render = vi.mocked(ImageRenderer.prototype.generatePostCard);
		render.mockClear().mockReturnValueOnce(rendering.promise);
		await say("https://works.invalid/note/rendering", "10003");
		await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
		await patchCore({ extensions: { [LINKS]: { enabled: false } } });
		await vi.waitFor(async () =>
			expect((await extensions()).find((e) => e.id === LINKS)?.state).toBe("disabled"),
		);
		rendering.resolve(Buffer.from("late card"));
		await patchCore({ extensions: { [LINKS]: { enabled: true } } });
		await vi.waitFor(async () =>
			expect((await extensions()).find((e) => e.id === LINKS)?.state).toBe("running"),
		);
		await patchCore({ linkPreview: { replyForm: "text" } });
		await say("https://works.invalid/video/after", "10003");
		await vi.waitFor(async () => expect((await captures()).map((c) => c.kind)).toEqual(["text"]));
	});
});
