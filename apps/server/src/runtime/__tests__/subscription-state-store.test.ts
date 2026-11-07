/**
 * SubscriptionStateStore 单元测试 — Bug 1 修复的承重件。
 *
 * SubscriptionStateStore 把高频写入的 cachedProfile 从持久化 Subscription
 * 里外置出来,自带独立写路径且**不发任何事件**(无 MessageBus)——这正是切断
 * `config-changed:subscriptions → SubscriptionStore.replaceAll → subscription-changed
 * → DynamicPoller 重订阅 + [ops] 日志刷屏` 链条的关键。
 *
 * 覆盖:
 *  - 构造 API 不接收 MessageBus(结构性证明:patch 不可能 fan-out)
 *  - patch 逐键替换语义(空 patch 不冲掉 cachedProfile;不认识的键也逐键落盘)
 *  - get / getAll 返回克隆(就地改返回值不污染 store)
 *  - load 容忍 缺失 / 坏 JSON / 数组 / 非对象 → 起始为空,不抛
 *  - prune 丢孤儿 + 幂等(无可丢时不写盘)
 *  - 并发 patch+patch / patch+prune 经单 FIFO 串行,无丢写
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Logger, makeEmptySubscription } from "@bilibili-notify/internal";
import { createSubscriptionStore } from "@bilibili-notify/subscription";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import { i18n } from "../../i18n/index.js";
import { createNodeMessageBus } from "../message-bus.js";
import {
	createSubscriptionStateStore,
	pruneOrphanSubscriptionState,
	SUBSCRIPTION_STATE_FILE,
	type SubscriptionState,
	type SubscriptionStateStore,
} from "../subscription-state-store.js";

// 落盘函数前的闸默认敞开;只有「close」那组用例才 hold(见 support/storage-write-gate.ts)。
vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

function makeLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as unknown as Logger;
}

const PROFILE_A = {
	name: "UP-A",
	avatar: `${"a".repeat(64)}.png`,
	bio: "sign-a",
	followers: 100,
	refreshedAt: "2026-05-19T00:00:00.000Z",
};
const PROFILE_A2 = {
	...PROFILE_A,
	followers: 150,
	refreshedAt: "2026-05-19T00:02:00.000Z",
};
let dir: string;
let file: string;
let logger: Logger;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "subscription-state-test-"));
	file = join(dir, ...SUBSCRIPTION_STATE_FILE);
	logger = makeLogger();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function make(): SubscriptionStateStore {
	return createSubscriptionStateStore({ dataRoot: dir, logger });
}

async function readFileJson(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(file, "utf8"));
}

describe("SubscriptionStateStore — 构造契约 (Bug 1 结构证明)", () => {
	it("资料缓存落在 runtime/subscription-state.json", () => {
		expect(SUBSCRIPTION_STATE_FILE).toEqual(["runtime", "subscription-state.json"]);
	});

	it("createSubscriptionStateStore 选项只有 dataRoot/logger,不接收任何 MessageBus/事件汇", () => {
		// 纯结构断言:构造选项里没有 bus,所以 patch/prune 在源头上就不可能
		// fan-out 成 config-changed / subscription-changed —— Bug 1 链被切断。
		const store = make() as unknown as Record<string, unknown>;
		expect(typeof store.patch).toBe("function");
		expect(typeof store.prune).toBe("function");
		expect(typeof store.load).toBe("function");
		expect(typeof store.get).toBe("function");
		expect(typeof store.getAll).toBe("function");
		// 没有 emit/on/bus 这类事件成员
		expect(store.emit).toBeUndefined();
		expect(store.on).toBeUndefined();
		expect(store.bus).toBeUndefined();
	});
});

describe("SubscriptionStateStore.patch — 逐键替换语义", () => {
	it("空 store patch cachedProfile 创建条目", async () => {
		const store = make();
		await store.patch("s1", { cachedProfile: PROFILE_A });
		expect(store.get("s1")).toEqual({ cachedProfile: PROFILE_A });
		await expect(readFileJson()).resolves.toEqual({ s1: { cachedProfile: PROFILE_A } });
	});

	it("后续 cachedProfile patch 整格替换旧资料,不深合并", async () => {
		const store = make();
		await store.patch("s1", { cachedProfile: PROFILE_A });
		await store.patch("s1", { cachedProfile: PROFILE_A2 });
		expect(store.get("s1")).toEqual({ cachedProfile: PROFILE_A2 });
	});

	it("写另一个顶层键不冲掉已存在的 cachedProfile", async () => {
		const store = make();
		const withUnknown = { unknown: "kept" } as unknown as SubscriptionState;
		await store.patch("s1", withUnknown);
		await store.patch("s1", { cachedProfile: PROFILE_A });
		expect(store.get("s1")).toEqual({ unknown: "kept", cachedProfile: PROFILE_A });
	});

	it("不带这个键 = 别动它:空 patch 不冲掉 cachedProfile", async () => {
		const store = make();
		await store.patch("s1", { cachedProfile: PROFILE_A });
		await store.patch("s1", {});
		expect(store.get("s1")).toEqual({ cachedProfile: PROFILE_A });
	});

	it("空 partial 不丢任何已存在的键", async () => {
		const store = make();
		await store.patch("s1", { cachedProfile: PROFILE_A });
		await store.patch("s1", {});
		expect(store.get("s1")).toEqual({ cachedProfile: PROFILE_A });
	});

	it("逐键遍历不点名:SubscriptionState 里没写的键也原样落盘", async () => {
		const store = make();
		await store.patch("s1", {
			cachedProfile: PROFILE_A,
			unrecognized: "kept",
		} as unknown as SubscriptionState);
		expect(store.get("s1")).toEqual({
			cachedProfile: PROFILE_A,
			unrecognized: "kept",
		});
		await expect(readFileJson()).resolves.toMatchObject({ s1: { unrecognized: "kept" } });
	});

	/**
	 * 🔴 **判「键在不在」,不判「值是不是 undefined」。**
	 *
	 * 显式传 `undefined` 的意思是「把上次那个值**清掉**」。按值判的话这一清永远不生效。
	 * 而「不带这个键」仍然是「别动它」—— 空 patch 就靠这个不冲掉 cachedProfile。
	 */
	it("🔴 显式传 undefined = 清掉这个键;不带这个键 = 别动它", async () => {
		const store = make();
		await store.patch("s1", { cachedProfile: PROFILE_A });

		await store.patch("s1", { cachedProfile: undefined });
		expect(store.get("s1")).toEqual({});
		await expect(readFileJson()).resolves.toEqual({ s1: {} });

		await store.patch("s1", { cachedProfile: PROFILE_A });
		await store.patch("s1", { cachedProfile: PROFILE_A2 });
		expect(store.get("s1")).toEqual({ cachedProfile: PROFILE_A2 });
	});
});

describe("SubscriptionStateStore.get / getAll — 防御性克隆", () => {
	it("get 返回克隆:就地改返回值不污染 store", async () => {
		const store = make();
		await store.patch("s1", { cachedProfile: { ...PROFILE_A } });
		const r = store.get("s1") as { cachedProfile: { name: string } };
		expect(r).toBeDefined();
		r.cachedProfile.name = "MUTATED";
		const reread = store.get("s1") as { cachedProfile: { name: string } };
		expect(reread.cachedProfile.name).toBe("UP-A");
	});

	it("getAll 返回克隆:就地改不污染 store,且未 seed 的 id → undefined", async () => {
		const store = make();
		await store.patch("s1", { cachedProfile: { ...PROFILE_A } });
		const all = store.getAll();
		const s1 = all.s1 as { cachedProfile: { followers: number } };
		s1.cachedProfile.followers = -999;
		const reread = store.getAll().s1 as { cachedProfile: { followers: number } };
		expect(reread.cachedProfile.followers).toBe(100);
		expect(store.get("does-not-exist")).toBeUndefined();
	});
});

describe("SubscriptionStateStore.load — 损坏输入容忍", () => {
	it("损坏数据日志跟随当前语言并保留原始异常", async () => {
		const state = i18n.state();
		const { mkdir } = await import("node:fs/promises");
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, "{ private-profile", "utf8");
		try {
			for (const [locale, message] of [
				["zh-CN", "订阅运行态读取失败，使用空状态"],
				["en", "Failed to load subscription state; using empty state"],
				["ja", "購読状態を読み込めなかったため、空の状態を使用します"],
				["zh-TW", "訂閱執行狀態讀取失敗，使用空狀態"],
			] as const) {
				i18n.set({ locale, voice: "maid" });
				await make().load();
				expect(logger.warn).toHaveBeenLastCalledWith(message, { error: expect.any(SyntaxError) });
			}
			expect(logger.warn).toHaveBeenCalledTimes(4);
		} finally {
			i18n.set({ locale: state.locale, voice: state.voice });
		}
	});

	it("文件缺失 → 起始为空,不抛,不告警 ENOENT", async () => {
		const store = make();
		await expect(store.load()).resolves.toBeUndefined();
		expect(store.getAll()).toEqual({});
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("坏 JSON → 起始为空,不抛", async () => {
		await writeFile(file, "{ this is not json", "utf8").catch(async () => {
			// 目录可能还没建,先建再写
			const { mkdir } = await import("node:fs/promises");
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, "{ this is not json", "utf8");
		});
		const store = make();
		await expect(store.load()).resolves.toBeUndefined();
		expect(store.getAll()).toEqual({});
		expect(logger.warn).toHaveBeenCalled();
	});

	it("数组 JSON → 起始为空,不抛", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify([1, 2, 3]), "utf8");
		const store = make();
		await store.load();
		expect(store.getAll()).toEqual({});
		expect(logger.warn).toHaveBeenCalled();
	});

	it("非对象 JSON(字符串/数字)→ 起始为空,不抛", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify("hello"), "utf8");
		const store = make();
		await store.load();
		expect(store.getAll()).toEqual({});
		expect(logger.warn).toHaveBeenCalled();
	});

	it("合法对象 JSON → 加载进 records", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify({ s1: { cachedProfile: PROFILE_A } }), "utf8");
		const store = make();
		await store.load();
		expect(store.get("s1")).toEqual({ cachedProfile: PROFILE_A });
	});

	it("load 幂等:二次 load 不覆盖已发生的 patch", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify({ s1: { cachedProfile: PROFILE_A } }), "utf8");
		const store = make();
		await store.load();
		await store.patch("s1", { cachedProfile: PROFILE_A2 });
		await store.load(); // 第二次 — loaded 已置位,应是 no-op
		expect(store.get("s1")).toEqual({ cachedProfile: PROFILE_A2 });
	});
});

describe("SubscriptionStateStore.listImageRefs — 图库清扫要的「资料缓存引用着谁」", () => {
	const REF_A = `${"a".repeat(64)}.png`;
	const REF_B = `${"b".repeat(64)}.webp`;
	/** 拓展订阅的资料:没有头像(两格都缺)。 */
	const PROFILE_NO_AVATAR = {
		name: "拓展甲",
		refreshedAt: "2026-05-19T00:00:00.000Z",
	};

	it("交出所有订阅资料里存进图库的头像(去重);没有头像的不算", async () => {
		const store = make();
		await store.patch("ext-1", { cachedProfile: { ...PROFILE_NO_AVATAR, avatar: REF_A } });
		await store.patch("ext-2", { cachedProfile: { ...PROFILE_NO_AVATAR, avatar: REF_A } });
		await store.patch("ext-3", { cachedProfile: { ...PROFILE_NO_AVATAR, avatar: REF_B } });
		await store.patch("ext-4", { cachedProfile: PROFILE_NO_AVATAR });
		await store.patch("bili-2", { cachedProfile: PROFILE_NO_AVATAR });

		expect((await store.listImageRefs()).sort()).toEqual([REF_A, REF_B]);
	});

	it("头像换了,旧的就不再被引用;订阅被丢掉,它的头像也不再被引用", async () => {
		const store = make();
		await store.patch("ext-1", { cachedProfile: { ...PROFILE_NO_AVATAR, avatar: REF_A } });
		await store.patch("ext-2", { cachedProfile: { ...PROFILE_NO_AVATAR, avatar: REF_B } });
		await store.patch("ext-1", { cachedProfile: { ...PROFILE_NO_AVATAR, avatar: REF_B } });
		expect(await store.listImageRefs()).toEqual([REF_B]);

		await store.prune([]);
		expect(await store.listImageRefs()).toEqual([]);
	});

	it("还没 load 就被问(清扫赶在开机载入之前):先载入盘上的再答,不拿空名单去删图", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(dirname(file), { recursive: true });
		await writeFile(
			file,
			JSON.stringify({ s1: { cachedProfile: { ...PROFILE_NO_AVATAR, avatar: REF_A } } }),
			"utf8",
		);
		const store = make();
		expect(await store.listImageRefs()).toEqual([REF_A]);
		// 载入只发生一次:之后的 patch 不会被再来一次的 load 盖掉。
		await store.patch("s1", { cachedProfile: { ...PROFILE_NO_AVATAR, avatar: REF_B } });
		expect(await store.listImageRefs()).toEqual([REF_B]);
	});
});

describe("pruneOrphanSubscriptionState — 保留名单是两支订阅的全部 id(ADR-0019 决策 47)", () => {
	it("拓展订阅的资料缓存不被当成孤儿抹掉;真孤儿照丢", async () => {
		const runtime = make();
		const subs = createSubscriptionStore(createNodeMessageBus());
		const bili = makeEmptySubscription({
			id: "b1",
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		const ext = makeExtensionSubscription({ id: "e1" });
		subs.replaceAll([bili, ext]);
		await runtime.patch("b1", { cachedProfile: PROFILE_A });
		await runtime.patch("e1", { cachedProfile: PROFILE_A2 });
		await runtime.patch("gone", { cachedProfile: PROFILE_A });

		await pruneOrphanSubscriptionState(runtime, {
			getSubscriptionIds: () => subs.list().map((s) => s.id),
		});

		expect(Object.keys(runtime.getAll()).sort()).toEqual(["b1", "e1"]);
	});
});

describe("SubscriptionStateStore.prune — 孤儿清理 + 幂等", () => {
	it("丢掉不在 keepIds 里的条目", async () => {
		const store = make();
		await store.patch("keep", { cachedProfile: PROFILE_A });
		await store.patch("orphan", { cachedProfile: PROFILE_A2 });
		await store.prune(["keep"]);
		expect(store.get("keep")).toEqual({ cachedProfile: PROFILE_A });
		expect(store.get("orphan")).toBeUndefined();
		await expect(readFileJson()).resolves.toEqual({ keep: { cachedProfile: PROFILE_A } });
	});

	it("空 keepIds → 全清", async () => {
		const store = make();
		await store.patch("a", { cachedProfile: PROFILE_A });
		await store.patch("b", { cachedProfile: PROFILE_A2 });
		await store.prune([]);
		expect(store.getAll()).toEqual({});
	});

	it("无可丢时幂等:不写盘", async () => {
		const store = make();
		await store.patch("a", { cachedProfile: PROFILE_A });
		// 删除 patch 写出的文件,再 prune(keepIds 覆盖全部)。若 prune 仍写盘,
		// 文件会被重建 → readFile 成功;期望 prune 短路不写,文件保持不存在。
		await rm(file, { force: true });
		await store.prune(["a"]);
		await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(store.get("a")).toEqual({ cachedProfile: PROFILE_A });
	});

	it("空 store prune → no-op,不抛,不写盘", async () => {
		const store = make();
		await store.prune(["x", "y"]);
		await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("SubscriptionStateStore — 并发串行(单 FIFO,无丢写)", () => {
	it("两个未 await 的 patch 串行后两 key 都在", async () => {
		const store = make();
		const p1 = store.patch("a", { cachedProfile: PROFILE_A });
		const p2 = store.patch("b", { cachedProfile: PROFILE_A2 });
		await Promise.all([p1, p2]);
		expect(store.get("a")).toEqual({ cachedProfile: PROFILE_A });
		expect(store.get("b")).toEqual({ cachedProfile: PROFILE_A2 });
		await expect(readFileJson()).resolves.toEqual({
			a: { cachedProfile: PROFILE_A },
			b: { cachedProfile: PROFILE_A2 },
		});
	});

	it("同一 id 两个并发 patch(cachedProfile 更新 + 空 patch)合并不丢键", async () => {
		const store = make();
		const p1 = store.patch("s1", { cachedProfile: PROFILE_A });
		const p2 = store.patch("s1", {});
		await Promise.all([p1, p2]);
		expect(store.get("s1")).toEqual({ cachedProfile: PROFILE_A });
	});

	it("patch 与 prune 并发串行:prune 在 patch 之后看到新条目", async () => {
		const store = make();
		await store.patch("keep", { cachedProfile: PROFILE_A });
		// 不 await:patch('new') 入队,紧接 prune(['keep','new']) 入队
		const pPatch = store.patch("new", { cachedProfile: PROFILE_A2 });
		const pPrune = store.prune(["keep", "new"]);
		await Promise.all([pPatch, pPrune]);
		// patch 先执行 → prune 时 'new' 已在 records 且在 keepIds → 两者都保留
		expect(store.get("keep")).toEqual({ cachedProfile: PROFILE_A });
		expect(store.get("new")).toEqual({ cachedProfile: PROFILE_A2 });
	});

	it("prune 后紧跟同 id patch:FIFO 保证 patch 重建该条目", async () => {
		const store = make();
		await store.patch("s1", { cachedProfile: PROFILE_A });
		const pPrune = store.prune([]); // 清空
		const pPatch = store.patch("s1", { cachedProfile: PROFILE_A2 });
		await Promise.all([pPrune, pPatch]);
		expect(store.get("s1")).toEqual({ cachedProfile: PROFILE_A2 });
	});

	it("persist 失败不毒化队列:错误传给调用方,后续 patch 仍执行", async () => {
		// dataDir 指向一个**已存在的文件**,使 atomicWriteJson 的 mkdir(dirname)
		// 抛 ENOTDIR —— 确定性地走 persist 的 catch→rethrow 分支。
		const collisionFile = join(dir, "not-a-dir");
		await writeFile(collisionFile, "x", "utf8");
		const store = createSubscriptionStateStore({ dataRoot: collisionFile, logger });

		await expect(store.patch("bad", { cachedProfile: PROFILE_A })).rejects.toBeDefined();
		// 错误已抛给调用方且 logger.warn 记了一笔
		expect(logger.warn).toHaveBeenCalled();
		// 队列没被毒化:把 dataDir 换成正常目录的新实例可正常工作
		// (同实例下 records 已就地改但盘写失败 —— get 反映内存态,验证不毒化即可)
		const ok = createSubscriptionStateStore({ dataRoot: dir, logger });
		await ok.patch("ok", { cachedProfile: PROFILE_A });
		expect(ok.get("ok")).toEqual({ cachedProfile: PROFILE_A });
	});

	it("ENOTDIR 失败后,同实例后续正常 patch 仍执行(队列未毒化)", async () => {
		// 先把 dataDir 故意设成已存在文件,首笔 persist 必 ENOTDIR;但 records
		// 已就地改 → 内存态可见,且 catch→rethrow 不毒化 FIFO 队列。
		const collisionFile = join(dir, "poison-probe");
		await writeFile(collisionFile, "x", "utf8");
		const store = createSubscriptionStateStore({ dataRoot: collisionFile, logger });
		await expect(store.patch("a", { cachedProfile: PROFILE_A })).rejects.toBeDefined();
		// 队列未毒化:下一笔 task 仍被调度执行(仍会 persist 失败,但 task 跑了 →
		// 内存 records 反映该写入,证明 queue.then 链没被永久 reject 卡死)。
		await expect(store.patch("b", { cachedProfile: PROFILE_A2 })).rejects.toBeDefined();
		expect(store.get("a")).toEqual({ cachedProfile: PROFILE_A });
		expect(store.get("b")).toEqual({ cachedProfile: PROFILE_A2 });
	});
});

describe("SubscriptionStateStore.close", () => {
	beforeEach(() => storageWriteGate.reset());
	afterEach(() => storageWriteGate.reset());

	it("close 等在途的写落盘", async () => {
		const store = make();
		storageWriteGate.hold();
		const writing = store.patch("s1", { cachedProfile: PROFILE_A });
		await storageWriteGate.arrived();

		let closed = false;
		const closing = store.close().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(closed).toBe(false);

		storageWriteGate.release();
		await closing;
		await writing;
		await expect(readFileJson()).resolves.toEqual({ s1: { cachedProfile: PROFILE_A } });
	});

	it("close 之后的写被拒且不碰盘", async () => {
		const store = make();
		await store.patch("s1", { cachedProfile: PROFILE_A });
		const before = await readFile(file, "utf8");
		await store.close();
		const writesAtClose = storageWriteGate.writes;

		await expect(store.patch("s1", { cachedProfile: PROFILE_A2 })).rejects.toMatchObject({
			code: "queue_closed",
		});
		await expect(store.prune([])).rejects.toMatchObject({ code: "queue_closed" });

		expect(storageWriteGate.writes).toBe(writesAtClose);
		expect(await readFile(file, "utf8")).toBe(before);
		expect(store.get("s1")).toEqual({ cachedProfile: PROFILE_A });
	});
});
