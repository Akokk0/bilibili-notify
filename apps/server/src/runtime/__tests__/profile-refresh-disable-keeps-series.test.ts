import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FollowersRefreshEntry, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeProfileImages } from "../../__tests__/support/profile-images.js";
import { createFollowersStore, FOLLOWERS_DIR } from "../../followers/store.js";
import { createNodeMessageBus } from "../message-bus.js";
import type { ProfileRefreshHandle } from "../profile-refresh.js";
import type { SubRuntime } from "../sub-runtime-store.js";
import { startMigratedProfileRefresh } from "./profile-refresh-support.js";

/**
 * 停用 ≠ 删除(ADR-0020 决策 10,修背景第 7 条老漏洞)。
 *
 * - 停用只把 UP 从首页粉丝面板的快照里拿掉,**粉丝时序文件留着** —— 统计页照样列着他,
 *   曲线不能跟着清空;再启用接着往同一份文件里记。
 * - 删订阅才删文件。
 * - tick 在跑时删了订阅:样本写入若已排在记录器队里,删订阅的 `drop` 排在它后面,文件不会再长回来。
 *
 * 粉丝仓用真的(tmpdir),文件在不在就是断言本身。文件按**订阅 id** 命名(ADR-0020 决策 2
 * 的 🔗):下面订阅 id 是 "a" / "b",uid 是 "1" / "2"。
 */

// cron 换成不排程的假货(同 profile-refresh-track 等的套路)。真的 CronJob 按墙钟每 10 分钟整点放一轮 tick,
// 不归 serviceCtx 管:用例跨过整点时它会插进来多跑一轮。
vi.mock("cron", () => ({
	CronJob: class {
		start(): void {}
		stop(): void {}
	},
}));

const GLOBALS = { profileRefreshCron: "*/10 * * * *" } as never;

let dataDir: string;
let handle: ProfileRefreshHandle | undefined;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-profile-refresh-"));
});
afterEach(async () => {
	handle?.dispose();
	handle = undefined;
	await rm(dataDir, { recursive: true, force: true });
});

function biliSub(id: string, uid: string, enabled = true) {
	return { id, identity: { sourceKey: "bilibili", externalId: uid }, enabled };
}

function fanFile(key: string): string {
	return join(dataDir, ...FOLLOWERS_DIR, `${key}.jsonl`);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function samples(key: string): Promise<number[]> {
	const raw = await readFile(fanFile(key), "utf8");
	return raw
		.trim()
		.split("\n")
		.map((line) => (JSON.parse(line) as { followers: number }).followers);
}

async function start(initial: ReturnType<typeof biliSub>[]) {
	let subs = initial;
	const followers = new Map<string, number>();
	const runtime = new Map<string, SubRuntime>();
	const bus = createNodeMessageBus();
	const snapshots: FollowersRefreshEntry[][] = [];
	bus.on("followers-refreshed", ({ entries }) => {
		snapshots.push(entries);
	});
	const serviceCtx = {
		setTimeout: vi.fn(() => undefined),
		setInterval: vi.fn(() => undefined),
		track: vi.fn(),
		signal: new AbortController().signal,
	};
	handle = startMigratedProfileRefresh({
		images: fakeProfileImages(),
		isStatsEnabled: () => true,
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
		fansStore: createFollowersStore({
			dataRoot: dataDir,
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		}),
		api: {
			fetchUserCard: vi.fn(async (uid: string) =>
				ok({
					data: { card: { fans: followers.get(uid) ?? 0, name: `UP${uid}`, face: "", sign: "" } },
				}),
			),
		} as never,
		// 不放行启动那次 3s 延时 tick:只看各用例自己 pollNow 的那几轮。
		serviceCtx: serviceCtx as never,
	});
	// 启动恢复跑完才会去排那个 3s 延时 —— 等它被排上,恢复就不会和用例的 tick 交错。
	await vi.waitFor(() => expect(serviceCtx.setTimeout).toHaveBeenCalled());
	return {
		bus,
		handle,
		followers,
		runtime,
		snapshots,
		setSubs(next: ReturnType<typeof biliSub>[]) {
			subs = next;
		},
		lastSnapshotUids(): Array<string | undefined> {
			return (snapshots.at(-1) ?? []).map((e) => e.identity.externalId);
		},
	};
}

describe("profile refresh:粉丝文件按订阅 id 读写", () => {
	it("开机恢复读的是订阅 id 那份:面板首屏就有上次的粉丝数", async () => {
		await mkdir(join(dataDir, ...FOLLOWERS_DIR), { recursive: true });
		await writeFile(
			fanFile("a"),
			`${JSON.stringify({ sampledAt: "2026-05-16T00:00:00.000Z", followers: 777 })}\n`,
		);
		const p = await start([biliSub("a", "1")]);
		expect(p.handle.getLastEntries()).toEqual([
			expect.objectContaining({
				identity: { sourceKey: "bilibili", externalId: "1" },
				current: 777,
			}),
		]);
	});
});

describe("profile refresh:停用留着粉丝时序,删除才删", () => {
	it("停用 → 下一轮撤出快照,粉丝文件还在", async () => {
		const p = await start([biliSub("a", "1"), biliSub("b", "2")]);
		p.followers.set("1", 100).set("2", 200);
		expect(await p.handle.pollNow()).toBe(true);
		expect(await samples("a")).toEqual([100]);
		// 写的是订阅 id 那份,uid 那份从头到尾不出现。
		expect(await exists(fanFile("1"))).toBe(false);

		p.setSubs([biliSub("a", "1", false), biliSub("b", "2")]);
		expect(await p.handle.pollNow()).toBe(true);

		expect(p.lastSnapshotUids()).toEqual(["2"]);
		expect(p.handle.getLastEntries().map((e) => e.identity.externalId)).toEqual(["2"]);
		expect(await exists(fanFile("a"))).toBe(true);
		expect(await samples("a")).toEqual([100]);
	});

	it("再启用 → 接着往同一份文件里追加,起点仍是最初那次采样", async () => {
		const p = await start([biliSub("a", "1"), biliSub("b", "2")]);
		p.followers.set("1", 100).set("2", 200);
		await p.handle.pollNow();

		p.setSubs([biliSub("a", "1", false), biliSub("b", "2")]);
		await p.handle.pollNow();

		p.setSubs([biliSub("a", "1"), biliSub("b", "2")]);
		p.followers.set("1", 150);
		await p.handle.pollNow();

		expect(await samples("a")).toEqual([100, 150]);
		const entry = p.handle.getLastEntries().find((e) => e.identity.externalId === "1");
		expect(entry).toMatchObject({ current: 150, deltaSubscribed: 50 });
		expect(p.lastSnapshotUids()).toContain("1");
	});

	it("删订阅 → 文件删掉,快照立刻撤掉他", async () => {
		const p = await start([biliSub("a", "1"), biliSub("b", "2")]);
		p.followers.set("1", 100).set("2", 200);
		await p.handle.pollNow();
		expect(await exists(fanFile("a"))).toBe(true);

		// 事件到的时候订阅仓已经是删完的样子(config-changed → replaceAll → subscription-changed)。
		p.setSubs([biliSub("b", "2")]);
		p.bus.emit("subscription-changed", {
			ops: [{ kind: "remove", sub: biliSub("a", "1") as never }],
		});

		await vi.waitFor(async () => expect(await exists(fanFile("a"))).toBe(false));
		expect(p.lastSnapshotUids()).toEqual(["2"]);
		expect(await exists(fanFile("b"))).toBe(true);
	});
});
