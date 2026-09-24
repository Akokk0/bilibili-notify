import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FansRefreshEntry, Subscription } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { createFansStore } from "../../fans/store.js";
import { type FansPollerHandle, startFansPoller } from "../fans-poller.js";
import { createNodeMessageBus } from "../message-bus.js";
import type { SubRuntime } from "../sub-runtime-store.js";

/**
 * 首页粉丝面板也列拓展订阅(ADR-0020 决策 8)。
 *
 * - 有粉丝时序(`<dataDir>/fans/<订阅 id>.jsonl`,统计的拓展适配按资料里的粉丝数写)的、启用着的拓展订阅进
 *   `fans-refreshed` 快照 / `GET /api/fans`:键是订阅 id,带拓展 id + 外部 id、不带 uid。
 * - 起点 / 24h / 7d 与 B 站同一个意思、从时序里算:起点 = **第一条样本**(B 站的 fansBaseline 是第一次采到的
 *   值、开机按时序最早一条自愈 —— 同一件事);24h / 7d = 那一刻之前最近的一条样本。
 * - 当前数取它最近报的资料(比稀释过的样本新,与统计页的「当前粉丝」同一个数);资料没带就取时序末值。
 * - 停用的、没有时序的(平台不报粉丝数)不上面板,同 B 站;粉丝轮询**不问**拓展订阅(那是 B 站独有的)。
 *
 * 粉丝仓用真的(tmpdir):「有没有时序」就是盘上那份文件。
 */

const GLOBALS = { app: { fansCron: "*/10 * * * *" } } as never;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let dataDir: string;
let handle: FansPollerHandle | undefined;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-fans-poller-ext-"));
});
afterEach(async () => {
	handle?.dispose();
	handle = undefined;
	await rm(dataDir, { recursive: true, force: true });
});

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function writeSeries(key: string, samples: Array<{ ts: string; value: number }>) {
	await mkdir(join(dataDir, "fans"), { recursive: true });
	await writeFile(
		join(dataDir, "fans", `${key}.jsonl`),
		samples.map((s) => `${JSON.stringify(s)}\n`).join(""),
	);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** 抖音订阅 e1:十天前开始记,每隔几天一条。 */
const E1_SERIES = [
	{ ts: iso(10 * DAY), value: 100 },
	{ ts: iso(8 * DAY), value: 150 },
	{ ts: iso(2 * DAY), value: 300 },
	{ ts: iso(HOUR), value: 400 },
];

function extSub(id: string, externalId: string, enabled = true): Subscription {
	return makeExtensionSubscription({ id, extensionId: "douyin", externalId, enabled });
}

function biliSub(id: string, uid: string, enabled = true): Subscription {
	return { kind: "bilibili", id, uid, enabled } as never;
}

async function start(initial: Subscription[], runtimeSeed: Record<string, SubRuntime> = {}) {
	let subs = initial;
	const runtime = new Map<string, SubRuntime>(Object.entries(runtimeSeed));
	const bus = createNodeMessageBus();
	const snapshots: FansRefreshEntry[][] = [];
	bus.on("fans-refreshed", (entries) => {
		snapshots.push(entries);
	});
	const getRelationStat = vi.fn(async (_uid: string) => ({
		code: 0,
		data: { follower: 777 },
	}));
	const getUserCardInfo = vi.fn(async (uid: string) => ({
		code: 0,
		data: { card: { fans: 777, name: `UP${uid}`, face: "", sign: "" } },
	}));
	const serviceCtx = {
		setTimeout: vi.fn(() => undefined),
		setInterval: vi.fn(() => undefined),
	};
	handle = startFansPoller({
		bus,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list: () => [...subs] } as never,
		subRuntimeStore: {
			get: (id: string) => runtime.get(id),
			getAll: () => Object.fromEntries(runtime),
			patch: async (id: string, patch: SubRuntime) => {
				runtime.set(id, { ...runtime.get(id), ...patch });
			},
			prune: vi.fn(async () => {}),
			load: vi.fn(async () => {}),
		} as never,
		fansStore: createFansStore({
			dataDir,
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		}),
		api: {
			getUserCardsBatch: vi.fn(async () => ({ code: 0, data: {} })),
			getRelationStat,
			getUserCardInfo,
		} as never,
		// 不放行启动那次 3s 延时 tick:只看各用例自己 pollNow 的那几轮。
		serviceCtx: serviceCtx as never,
	});
	// 启动恢复跑完才会去排那个 3s 延时 —— 等它被排上,恢复就不会和用例的 tick 交错。
	await vi.waitFor(() => expect(serviceCtx.setTimeout).toHaveBeenCalled());
	return {
		bus,
		handle,
		runtime,
		snapshots,
		getRelationStat,
		getUserCardInfo,
		setSubs(next: Subscription[]) {
			subs = next;
		},
		entryOf(id: string): FansRefreshEntry | undefined {
			return handle?.getLastEntries().find((e) => e.subscriptionId === id);
		},
	};
}

/** 资料缓存里的一份资料;`fans` 不给就是平台没报粉丝数。 */
function profile(fans?: number, lastRefreshedAt = iso(5 * 60_000)): SubRuntime {
	return {
		cachedProfile: {
			name: "抖音甲",
			avatar: "",
			sign: "",
			...(fans === undefined ? {} : { fans }),
			lastRefreshedAt,
		},
	};
}

describe("粉丝面板 × 拓展订阅:有时序的进快照,数从时序里算", () => {
	it("键是订阅 id、带拓展 id + 外部 id、不带 uid;当前 = 最近报的资料,起点 = 第一条样本,24h / 7d = 那一刻之前最近的样本", async () => {
		await writeSeries("e1", E1_SERIES);
		const lastRefreshedAt = iso(5 * 60_000);
		const p = await start([extSub("e1", "sec-1")], { e1: profile(450, lastRefreshedAt) });
		expect(await p.handle.pollNow()).toBe(true);

		expect(p.handle.getLastEntries()).toEqual([
			{
				subscriptionId: "e1",
				extensionId: "douyin",
				externalId: "sec-1",
				current: 450,
				ts: lastRefreshedAt,
				// 起点是十天前那第一条(100);24h 前最近的是两天前那条(300);7 天前最近的是八天前那条(150)。
				deltaSubscribed: 350,
				delta24h: 150,
				delta7d: 300,
			},
		]);
		// 粉丝轮询不拿外部 id 去问 B 站。
		expect(p.getRelationStat).not.toHaveBeenCalled();
		expect(p.getUserCardInfo).not.toHaveBeenCalled();
		// 快照照样 emit 出去 —— 面板靠它覆盖式刷新。
		expect(p.snapshots.at(-1)?.map((e) => e.subscriptionId)).toEqual(["e1"]);
	});

	it("资料里没带粉丝数 → 当前取时序末值,时刻是那条样本的", async () => {
		await writeSeries("e1", E1_SERIES);
		const p = await start([extSub("e1", "sec-1")], { e1: profile(undefined) });
		await p.handle.pollNow();
		expect(p.entryOf("e1")).toMatchObject({
			current: 400,
			ts: E1_SERIES[3]?.ts,
			deltaSubscribed: 300,
			delta24h: 100,
			delta7d: 250,
		});
	});

	it("刚开始记、24h / 7d 之前还没有样本 → 那两格 null,起点照算", async () => {
		await writeSeries("e1", [{ ts: iso(HOUR), value: 400 }]);
		const p = await start([extSub("e1", "sec-1")], { e1: profile(420) });
		await p.handle.pollNow();
		expect(p.entryOf("e1")).toMatchObject({
			current: 420,
			deltaSubscribed: 20,
			delta24h: null,
			delta7d: null,
		});
	});

	it("没有时序的(平台不报粉丝数)不上面板 —— 资料里有个新建时种下的粉丝数也不算", async () => {
		const p = await start([extSub("e1", "sec-1")], { e1: profile(450) });
		await p.handle.pollNow();
		expect(p.handle.getLastEntries()).toEqual([]);
		expect(p.snapshots.at(-1)).toEqual([]);
	});

	it("停用的不上面板(文件留着);再启用下一轮回来", async () => {
		await writeSeries("e1", E1_SERIES);
		const p = await start([extSub("e1", "sec-1", false)], { e1: profile(450) });
		await p.handle.pollNow();
		expect(p.handle.getLastEntries()).toEqual([]);
		expect(await exists(join(dataDir, "fans", "e1.jsonl"))).toBe(true);

		p.setSubs([extSub("e1", "sec-1", true)]);
		await p.handle.pollNow();
		expect(p.entryOf("e1")?.current).toBe(450);

		// 上了面板再停用:下一轮撤掉(同 B 站「停用等这一轮的 sweep」)。
		p.setSubs([extSub("e1", "sec-1", false)]);
		await p.handle.pollNow();
		expect(p.entryOf("e1")).toBeUndefined();
		expect(p.snapshots.at(-1)).toEqual([]);
	});

	it("B 站条目照旧,多带订阅 id;两支同在一份快照里", async () => {
		await writeSeries("e1", E1_SERIES);
		const p = await start([biliSub("b1", "12345"), extSub("e1", "12345")], {
			e1: profile(450),
		});
		await p.handle.pollNow();
		const bili = p.entryOf("b1");
		expect(bili).toEqual({
			subscriptionId: "b1",
			uid: "12345",
			current: 777,
			ts: expect.any(String),
			// 第一次见 → 当前值就是起点;24h / 7d 之前没有样本。
			deltaSubscribed: 0,
			delta24h: null,
			delta7d: null,
		});
		// 外部 id 恰好是同一串数字:两条各是各的,拓展那条不带 uid。
		expect(p.entryOf("e1")).toMatchObject({ extensionId: "douyin", externalId: "12345" });
		expect(p.entryOf("e1")).not.toHaveProperty("uid");
		expect(p.getRelationStat).not.toHaveBeenCalled();
		expect(p.getUserCardInfo).toHaveBeenCalledTimes(1);
		expect(p.getUserCardInfo).toHaveBeenCalledWith("12345");
	});

	it("开机恢复也带拓展条目:首屏不必等第一轮", async () => {
		await writeSeries("e1", E1_SERIES);
		const p = await start([extSub("e1", "sec-1")], { e1: profile(450) });
		expect(p.entryOf("e1")).toMatchObject({ current: 450, deltaSubscribed: 350 });
		expect(p.snapshots.at(-1)?.map((e) => e.subscriptionId)).toEqual(["e1"]);
	});
});

describe("粉丝面板 × 拓展订阅:什么时候刷新", () => {
	it("拓展报了新的粉丝数(subscription-profiles-changed)→ 不等下一轮,当场刷新那一条并 emit", async () => {
		await writeSeries("e1", E1_SERIES);
		const p = await start([extSub("e1", "sec-1"), extSub("e2", "sec-2")], {
			e1: profile(450),
		});
		await p.handle.pollNow();
		const before = p.snapshots.length;

		p.runtime.set("e1", profile(500));
		// 不是拓展订阅的 id、没有时序的 id 混在里面也不碍事。
		p.bus.emit("subscription-profiles-changed", ["e1", "e2", "b-unknown"]);
		await vi.waitFor(() => expect(p.snapshots.length).toBeGreaterThan(before));
		expect(p.snapshots.at(-1)).toEqual([
			expect.objectContaining({ subscriptionId: "e1", current: 500 }),
		]);
		expect(p.entryOf("e1")).toMatchObject({ current: 500, deltaSubscribed: 400 });
	});

	it("停用着的报了资料也不上面板", async () => {
		await writeSeries("e1", E1_SERIES);
		const p = await start([extSub("e1", "sec-1", false)], { e1: profile(450) });
		p.bus.emit("subscription-profiles-changed", ["e1"]);
		// 给它一点时间:要是会上面板,这里早该有了。
		await new Promise((r) => setTimeout(r, 50));
		expect(p.handle.getLastEntries()).toEqual([]);
	});

	it("删掉拓展订阅 → 当场撤掉并 emit;它的粉丝文件不归粉丝轮询删(统计的拓展适配删)", async () => {
		await writeSeries("e1", E1_SERIES);
		const sub = extSub("e1", "sec-1");
		const p = await start([sub], { e1: profile(450) });
		await p.handle.pollNow();
		expect(p.entryOf("e1")).toBeDefined();

		p.setSubs([]);
		p.bus.emit("subscription-changed", [{ type: "remove", sub: sub as never }]);
		expect(p.entryOf("e1")).toBeUndefined();
		expect(p.snapshots.at(-1)).toEqual([]);
		expect(await exists(join(dataDir, "fans", "e1.jsonl"))).toBe(true);
	});

	it("B 站风控退避期间,拓展条目照样刷新(拓展不问 B 站),B 站不再敲", async () => {
		await writeSeries("e1", E1_SERIES);
		const p = await start([biliSub("b1", "1"), extSub("e1", "sec-1")], {
			b1: { cachedProfile: { name: "B", avatar: "", sign: "", fans: 1, lastRefreshedAt: "x" } },
			e1: profile(450),
		});
		p.getRelationStat.mockResolvedValue({ code: -352, data: null } as never);
		await p.handle.pollNow();
		expect(p.getRelationStat).toHaveBeenCalledTimes(1);

		p.runtime.set("e1", profile(600));
		await p.handle.pollNow();
		expect(p.getRelationStat).toHaveBeenCalledTimes(1);
		expect(p.entryOf("e1")?.current).toBe(600);
	});
});
