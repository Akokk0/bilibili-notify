/**
 * 待审锐评草稿的存储。
 *
 * 审批开着的时候,生成出来的稿子不能只待在内存里 —— 主人可能过几个小时才回一句
 * `y`,中间容器重启过一次。所以落盘,而且**过期要能被发现**:48 小时没人理就丢掉
 * 并告诉主人一声,不能悄悄消失(主人只会以为这周的周报又没发)。
 *
 * 短 ID 是给人在**手机上打字**用的,所以字符集要避开看着一样的那几个 —— 批错一份
 * 就是把不该发的发出去了,而这正是审批要防的事。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createRoastDraftStore, DRAFT_TTL_MS, type RoastDraftStore } from "../roast-draft-store.js";

const logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	// biome-ignore lint/suspicious/noExplicitAny: 测试用的最小 logger 替身
} as any;

let dir: string;
let store: RoastDraftStore;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "roast-draft-"));
	store = createRoastDraftStore({ dataDir: dir, logger });
	await store.load();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** 一份榜单草稿的最小载荷。 */
function board(targets: string[] = ["t1"]) {
	return { kind: "board" as const, days: 7, targets, result: { pigeon: { uid: "1" } } };
}

describe("RoastDraftStore", () => {
	it("新建一份 → 分配短 ID,能按 ID 取回", async () => {
		const d = await store.add(board());
		expect(d.id).toBeTruthy();
		expect(store.get(d.id)?.kind).toBe("board");
	});

	it("短 ID 避开形近字符 —— 主人是在手机上打这几个字的", async () => {
		// 0/o、1/l/i 混起来会批错单,而批错的后果正是审批本身要防的。
		const ids = new Set<string>();
		for (let i = 0; i < 30; i++) ids.add((await store.add(board())).id);
		for (const id of ids) {
			expect(id, `${id} 含形近字符`).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]+$/);
		}
	});

	it("同时挂着多份 → ID 互不重复", async () => {
		const ids = new Set<string>();
		for (let i = 0; i < 30; i++) ids.add((await store.add(board())).id);
		expect(ids.size).toBe(30);
	});

	it("取走一份就没了 —— 同一份不能批两次", async () => {
		const d = await store.add(board());
		expect((await store.take(d.id))?.id).toBe(d.id);
		expect(await store.take(d.id)).toBeUndefined();
		expect(store.get(d.id)).toBeUndefined();
	});

	it("过期的不出现在待审列表里", async () => {
		const now = 1_000_000;
		await store.add(board(), now);
		expect(store.list(now + DRAFT_TTL_MS - 1)).toHaveLength(1);
		expect(store.list(now + DRAFT_TTL_MS + 1)).toHaveLength(0);
	});

	it("过期的也批不动 —— 主人隔三天回 y,不该把陈年榜单发出去", async () => {
		const now = 1_000_000;
		const d = await store.add(board(), now);
		expect(await store.take(d.id, now + DRAFT_TTL_MS + 1)).toBeUndefined();
	});

	it("sweep 把过期的清掉并交还给调用方(据此告诉主人一声)", async () => {
		const now = 1_000_000;
		const stale = await store.add(board(), now);
		const fresh = await store.add(board(), now + DRAFT_TTL_MS);

		const swept = await store.sweep(now + DRAFT_TTL_MS + 1);
		expect(swept.map((d) => d.id)).toEqual([stale.id]);
		// 交还过一次就不再交还,否则每轮 sweep 都通知一遍同一份。
		expect(await store.sweep(now + DRAFT_TTL_MS + 2)).toHaveLength(0);
		expect(store.get(fresh.id, now + DRAFT_TTL_MS + 2)).toBeTruthy();
	});

	it("重启后草稿还在 —— 主人隔夜回的那句 y 得还有东西可批", async () => {
		const d = await store.add(board(["t1", "t2"]));

		const reopened = createRoastDraftStore({ dataDir: dir, logger });
		await reopened.load();
		const got = reopened.get(d.id);
		expect(got?.id).toBe(d.id);
		// 目标是**生成那一刻的快照**:主人改配置改到别的群去了,这份已经审的
		// 还是该发去当初那几个群。
		expect(got?.targets).toEqual(["t1", "t2"]);
	});

	it("盘上文件坏了 → 当空的起,不让服务起不来", async () => {
		const { writeFile, mkdir } = await import("node:fs/promises");
		await mkdir(join(dir, "state"), { recursive: true });
		await writeFile(join(dir, "state", "roast-drafts.json"), "{ 这不是 json");

		const reopened = createRoastDraftStore({ dataDir: dir, logger });
		await reopened.load();
		expect(reopened.list()).toEqual([]);
		// 还得能继续用,不是只读一个废墟。
		expect((await reopened.add(board())).id).toBeTruthy();
	});
});
