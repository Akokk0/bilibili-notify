import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FansRefreshEntry } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFansStore } from "../../fans/store.js";
import { type FansPollerHandle, startFansPoller } from "../fans-poller.js";
import { createNodeMessageBus } from "../message-bus.js";
import type { SubRuntime } from "../sub-runtime-store.js";

/**
 * 停用 ≠ 删除(ADR-0020 决策 10,修背景第 7 条老漏洞)。
 *
 * - 停用只把 UP 从首页粉丝面板的快照里拿掉,**粉丝时序文件留着** —— 统计页照样列着他,
 *   曲线不能跟着清空;再启用接着往同一份文件里记。
 * - 删订阅才删文件。
 * - 🔴 tick 在跑时删了订阅:remove 监听先删了文件,那一轮随后又把样本写回去 —— 下一轮的
 *   清扫得把它再删掉(判据是「一条 B 站订阅都不剩」,不是「没启用」)。
 *
 * 粉丝仓用真的(tmpdir),文件在不在就是断言本身。
 */

const GLOBALS = { app: { fansCron: "*/10 * * * *" } } as never;

let dataDir: string;
let handle: FansPollerHandle | undefined;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-fans-poller-"));
});
afterEach(async () => {
	handle?.dispose();
	handle = undefined;
	await rm(dataDir, { recursive: true, force: true });
});

function biliSub(id: string, uid: string, enabled = true) {
	return { kind: "bilibili", id, uid, enabled };
}

function fanFile(uid: string): string {
	return join(dataDir, "fans", `${uid}.jsonl`);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function samples(uid: string): Promise<number[]> {
	const raw = await readFile(fanFile(uid), "utf8");
	return raw
		.trim()
		.split("\n")
		.map((line) => (JSON.parse(line) as { value: number }).value);
}

async function start(initial: ReturnType<typeof biliSub>[]) {
	let subs = initial;
	const followers = new Map<string, number>();
	const runtime = new Map<string, SubRuntime>();
	const bus = createNodeMessageBus();
	const snapshots: FansRefreshEntry[][] = [];
	bus.on("fans-refreshed", (entries) => {
		snapshots.push(entries);
	});
	const getRelationStat = vi.fn(async (uid: string) => ({
		code: 0,
		data: { follower: followers.get(uid) ?? 0 },
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
			getUserCardInfo: vi.fn(async (uid: string) => ({
				code: 0,
				data: { card: { fans: followers.get(uid) ?? 0, name: `UP${uid}`, face: "", sign: "" } },
			})),
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
		getRelationStat,
		setSubs(next: ReturnType<typeof biliSub>[]) {
			subs = next;
		},
		lastSnapshotUids(): string[] {
			return (snapshots.at(-1) ?? []).map((e) => e.uid);
		},
	};
}

describe("fans poller:停用留着粉丝时序,删除才删", () => {
	it("停用 → 下一轮撤出快照,粉丝文件还在", async () => {
		const p = await start([biliSub("a", "1"), biliSub("b", "2")]);
		p.followers.set("1", 100).set("2", 200);
		expect(await p.handle.pollNow()).toBe(true);
		expect(await samples("1")).toEqual([100]);

		p.setSubs([biliSub("a", "1", false), biliSub("b", "2")]);
		expect(await p.handle.pollNow()).toBe(true);

		expect(p.lastSnapshotUids()).toEqual(["2"]);
		expect(p.handle.getLastEntries().map((e) => e.uid)).toEqual(["2"]);
		expect(await exists(fanFile("1"))).toBe(true);
		expect(await samples("1")).toEqual([100]);
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

		expect(await samples("1")).toEqual([100, 150]);
		expect(p.runtime.get("a")?.fansBaseline?.value).toBe(100);
		const entry = p.handle.getLastEntries().find((e) => e.uid === "1");
		expect(entry).toMatchObject({ current: 150, deltaSubscribed: 50 });
		expect(p.lastSnapshotUids()).toContain("1");
	});

	it("删订阅 → 文件删掉,快照立刻撤掉他", async () => {
		const p = await start([biliSub("a", "1"), biliSub("b", "2")]);
		p.followers.set("1", 100).set("2", 200);
		await p.handle.pollNow();
		expect(await exists(fanFile("1"))).toBe(true);

		// 事件到的时候订阅仓已经是删完的样子(config-changed → replaceAll → subscription-changed)。
		p.setSubs([biliSub("b", "2")]);
		p.bus.emit("subscription-changed", [{ type: "remove", sub: biliSub("a", "1") as never }]);

		await vi.waitFor(async () => expect(await exists(fanFile("1"))).toBe(false));
		expect(p.lastSnapshotUids()).toEqual(["2"]);
		expect(await exists(fanFile("2"))).toBe(true);
	});

	it("tick 在跑时删了订阅 → 那一轮把文件写了回来,下一轮清扫再删掉", async () => {
		const p = await start([biliSub("a", "1")]);
		p.followers.set("1", 100);
		// 第一轮走 card(资料还没种上),之后稳态走 relation/stat —— 把闸放在第二轮上。
		await p.handle.pollNow();

		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		p.getRelationStat.mockImplementationOnce(async () => {
			await gate;
			return { code: 0, data: { follower: 101 } };
		});
		const inFlight = p.handle.pollNow();
		await vi.waitFor(() => expect(p.getRelationStat).toHaveBeenCalledTimes(1));

		p.setSubs([]);
		p.bus.emit("subscription-changed", [{ type: "remove", sub: biliSub("a", "1") as never }]);
		await vi.waitFor(async () => expect(await exists(fanFile("1"))).toBe(false));

		release();
		expect(await inFlight).toBe(true);
		// 前提:这一轮确实把文件写回来了 —— 否则下面的断言是空转。
		expect(await samples("1")).toEqual([101]);

		expect(await p.handle.pollNow()).toBe(true);
		await vi.waitFor(async () => expect(await exists(fanFile("1"))).toBe(false));
		expect(p.snapshots.at(-1)).toEqual([]);
		expect(p.handle.getLastEntries()).toEqual([]);
	});
});
