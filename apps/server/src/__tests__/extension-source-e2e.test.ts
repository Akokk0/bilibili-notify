/**
 * 🔴 **第 3 版的拓展订阅源,在真 BN 上经来源登记表跑通**(3b-42):拓展 `ctx.registerSource` 登记 → 装载器等登记落定
 * → 来源登记表 → 来源上下文 → 作品入口 / 场次引擎 / 资料写口。零件各有单元测试,但**零件全绿证明不了接上了**:
 * 装载器没递 `registerSource`、引擎没把拓展的来源登进表、作者名补链没接,症状都是拓展那头照样「报上去了」,
 * 而首页、历史、订阅页上什么都没有,没人报错。
 *
 * 所以装一个真的最小订阅源拓展进装载根(测试里写出来的 `index.mjs`,不是仓里的拓展包)、起一台真 BN:
 * 面板按它的动作钮报 —— 一条作品(进推送截流,恰好一条)、一条开播(在播表里有它,开播时刻是毫秒换来的 ISO)、
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
	SubscriptionDTO,
} from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { CORE_SETTINGS_FILE } from "../config/store.js";
import { type ServerHandle, startServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";
import { activeGeneration } from "./support/generation.js";

const PROBE = "source-probe";
const BROKEN = "source-broken";
const EXTERNAL = "probe-user-1";
/** 只靠拉取式(`fetchLiveStatus`)认出来的那位:探针对它回在播,从不 `reportLive`。 */
const PULLED = "probe-pulled-1";
const PULLED_SUB_ID = "e3000000-0000-4000-8000-000000000002";
const SUB_ID = "e3000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "e3000000-0000-4000-8000-00000000c001";
const TARGET_ID = "e3000000-0000-4000-8000-00000000d001";
const STARTED_AT = Date.UTC(2026, 8, 23, 12);

/** 每个动作真调一次 `ctx` 上的上报方法;`source` 是 `start` 时拿到的那面上下文。 */
const PROBE_CODE = `
const ID = ${JSON.stringify(EXTERNAL)};
let source;
export function activate(ctx) {
	ctx.registerSource({
		start(c) { source = c; },
		stop() {},
		searchCreators: async () => ({ ok: true, candidates: [] }),
		// 清单声明了开播 + 下播,登记时核要交(周期「正在直播」只经核心问来源)。
		fetchLiveStatus: async (identity) =>
			identity.externalId === ${JSON.stringify(PULLED)}
				? { ok: true, kind: "live", startedAt: ${STARTED_AT}, details: { title: "问到的标题" } }
				: { ok: true, kind: "offline" },
	});
	ctx.onAction("report.post", () =>
		source.reportPost(ID, {
			postId: "p1",
			url: "https://probe.invalid/p1",
			post: { publishedAt: ${STARTED_AT}, text: "今天去海边" },
		}),
	);
	ctx.onAction("report.badPost", () =>
		source.reportPost(ID, {
			postId: "p2",
			url: "https://probe.invalid/p2",
			post: { publishedAt: ${STARTED_AT}, text: "多了一格", title: "不开放的格" },
		}),
	);
	ctx.onAction("report.liveStart", () =>
		source.reportLive(ID, {
			kind: "start",
			startedAt: ${STARTED_AT},
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

	/** 同 `extension-live-e2e`:先空启动一趟拿到完整的 globals,再摆拓展、开开关,重起。 */
	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-ext-source-e2e-"));
		const seed = await boot(await findFreePort());
		await seed.close("seed");
		const gen = await activeGeneration(dataDir);

		const globalsPath = join(gen, ...CORE_SETTINGS_FILE);
		const globals = JSON.parse(await readFile(globalsPath, "utf8")) as Record<string, unknown>;
		globals.extensions = { [PROBE]: { enabled: true }, [BROKEN]: { enabled: true } };
		await writeFile(globalsPath, JSON.stringify(globals));

		for (const [id, name, code, actions, events] of [
			[
				PROBE,
				"来源探针",
				PROBE_CODE,
				["report.post", "report.badPost", "report.liveStart", "report.profile"],
				["post", "liveStart", "liveEnd"],
			],
			[BROKEN, "起不来的来源", BROKEN_CODE, undefined, ["post"]],
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
					apiVersion: 2,
					...(actions ? { actions } : {}),
					contributes: {
						subscription: {
							display: { label: "探针", shortLabel: "探", color: "#3366ff" },
							events,
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
		await okRes(await api("/api/dev/run/push.capture", json({ params: {} })));
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

	it("报一条开播:在播表里有它,标题、分区、累计观看照搬,开播时刻是毫秒换成的 ISO", async () => {
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
	it("拉取式认出一场:探针的 fetchLiveStatus 回在播、从不 reportLive → 在播表里有这一场,开播时刻是 ISO", async () => {
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
				const subs = (await (await api("/api/subscriptions")).json()) as SubscriptionDTO[];
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
});
