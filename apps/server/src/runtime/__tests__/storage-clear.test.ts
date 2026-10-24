/**
 * 「存储占用」的整类清空与手动清扫(㉙d,ADR-0027 决策 17)。**清空不可恢复**,所以每类都证明三件事:
 * 本类归零(或到约定的那一刻)、**别的类一个字节都不变**、幂等(再清一次回成功、0)。数据都造在自己建的临时目录里。
 *
 * 「别的类不变」那组用例里,跨类的图都落在 24 小时宽限期内(图库清扫看修改时间),所以随清理接上的那一次清扫
 * 不会误动它们;清扫自己的效果(过了宽限期、没人引用的图被收走,宽限期内的留着)单独几条用例钉。
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ClearableStorageCategory, StorageUsageRow } from "@bilibili-notify/contract";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	FRESH_MTIME,
	makeStorageWorld,
	OLD_MTIME,
	type StorageWorld,
} from "../../__tests__/support/storage-world.js";
import { readClearedThrough } from "../../history/retention.js";

let world: StorageWorld;
beforeEach(async () => {
	world = await makeStorageWorld();
});
afterEach(async () => {
	await world.dispose();
});

const imageLine = (...refs: string[]) =>
	`${refs.map((ref) => JSON.stringify({ messages: [{ payload: { image: ref } }] })).join("\n")}\n`;
const snapshot = (ref: string) => JSON.stringify({ messages: [{ payload: { image: ref } }] });
const chatFile = (...refs: string[]) => JSON.stringify({ messages: [{ images: refs }] });

async function rows(): Promise<Record<string, StorageUsageRow>> {
	const { rows: list } = await world.storage.list();
	return Object.fromEntries(list.map((r) => [r.category, r]));
}

/**
 * 让每一类都不是空的:跨类的图一律在宽限期内(清理接的清扫动不了它们)。
 * 清理自己那一类的细节由各自的用例另摆。
 */
async function seedEveryCategory() {
	const w = world;
	await w.file("data", "stats/posts/a.jsonl", 10);
	await w.file("data", "stats/live/a.jsonl", 20);
	await w.file("data", "stats/recording/a.jsonl", 30);
	await w.file("data", "stats/followers/a.jsonl", 40);
	await w.file("data", "uptime/hours.jsonl", 7);
	const hist = await w.image(w.writers.history, 11, FRESH_MTIME);
	const rep = await w.image(w.writers.repush, 12, FRESH_MTIME);
	const chat = await w.image(w.writers.chat, 13, FRESH_MTIME);
	const prof = await w.image(w.writers.profiles, 14, FRESH_MTIME);
	w.profileRefs.push(prof.ref);
	await w.write("data", "history/2026-10-05.jsonl", imageLine(hist.ref));
	await w.write("data", "history/retention.json", `{"clearedThrough":"2026-10-01"}`);
	await w.write("data", "history/repush/2026-10-05/row.json", snapshot(rep.ref));
	await w.write("data", "ai/conversations/c.json", chatFile(chat.ref));
	await w.file("host", "logs/2026-10-05.jsonl", 33);
	w.generations.push({
		seq: 1,
		current: false,
		partial: false,
		formatVersion: 1,
		createdBy: "1.0.0",
		lastActiveAt: null,
		deletable: true,
		lockReason: null,
		deletableAt: null,
		sizeBytes: 900,
		reclaimableBytes: 500,
	});
	return { hist, rep, chat, prof };
}

/** 每个类自己名下的文件(数据根下的相对路径前缀 / 名字判断):清哪一类,这些文件允许变。 */
const OWNED: Record<ClearableStorageCategory, (rel: string) => boolean> = {
	stats: (rel) => rel.startsWith("stats/"),
	// 日文件,连同它们的重推原件(行没了,原件就成了读不到的孤儿)。
	historyText: (rel) =>
		/^history\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(rel) || rel.startsWith("history/repush/"),
	// 重推原件与水位线(清到昨天会改写它)。
	historyImages: (rel) => rel.startsWith("history/repush/") || rel === "history/retention.json",
	ai: (rel) => rel.startsWith("ai/"),
};

/** 整个数据根与宿主根的日志:相对路径 → 字节数。 */
async function snapshotFiles(): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	for (const rel of await world.namesIn(world.dataRoot)) {
		out.set(rel, await world.bytesIn(join(world.dataRoot, rel)));
	}
	for (const rel of await world.namesIn(join(world.host, "logs"))) {
		out.set(`host:logs/${rel}`, await world.bytesIn(join(world.host, "logs", rel)));
	}
	return out;
}

/**
 * 清 `category` 之后:这一类归零,别的类**盘上的文件一个字节都没变**(同名同大小、没多没少),运行记录与图库也是。
 * 比的是文件而不是用量表的行:一张图的引用方没了它会改归「其它图片」,那是分类变了、文件没动。
 */
async function expectOthersUntouched(category: ClearableStorageCategory) {
	const before = await snapshotFiles();
	await world.storage.clear(category);
	const after = await snapshotFiles();
	for (const [rel, size] of before) {
		if (OWNED[category](rel)) continue;
		expect(after.get(rel), `清「${category}」不该动 ${rel}`).toBe(size);
	}
	for (const rel of after.keys()) {
		if (OWNED[category](rel)) continue;
		expect(before.has(rel), `清「${category}」凭空多出了 ${rel}`).toBe(true);
	}
	expect((await rows())[category]?.sizeBytes, `「${category}」没有清到零`).toBe(0);
	// 清文字:重推原件明确是被清空的(不是只放宽检查)。
	if (category === "historyText")
		expect(await world.namesIn(join(world.dataRoot, "history/repush"))).toEqual([]);
}

describe("整类清空:本类归零、别的类一个字节不变", () => {
	it.each(["stats", "historyText", "historyImages", "ai"] as const)("%s", async (category) => {
		await seedEveryCategory();
		// 先确认摆好了:这一类原本不是空的(否则「归零」是空绿)。
		expect((await rows())[category]?.sizeBytes).toBeGreaterThan(0);
		await expectOthersUntouched(category);
	});

	it.each(["stats", "historyText", "historyImages", "ai"] as const)(
		"%s:幂等,已经空了回成功、0",
		async (category) => {
			await seedEveryCategory();
			await world.storage.clear(category);
			expect(await world.storage.clear(category)).toEqual({ freedBytes: 0 });
		},
	);

	it("什么都没有时清哪一类都是 0,不抛", async () => {
		for (const category of ["stats", "historyText", "historyImages", "ai"] as const) {
			expect(await world.storage.clear(category)).toEqual({ freedBytes: 0 });
		}
	});

	it("每一趟清理都登记进 track(关停时等它)", async () => {
		await world.storage.clear("ai");
		await world.storage.clear("stats");
		await world.storage.sweepImages();
		expect(world.tracked).toHaveLength(3);
	});
});

describe("推送历史的图:清到昨天为止", () => {
	it("昨天及更早的图与重推原件被清,今天的留着;freedBytes 是实际腾出的", async () => {
		const w = world;
		// 「此刻」是 2026-10-06 12:00 UTC:昨天 = 10-05。图的修改时间都在宽限期之外,清不清只看引用。
		const old = await w.image(w.writers.history, 21); // 只被 10-04 的行引用
		const yest = await w.image(w.writers.history, 22); // 只被 10-05 的行引用
		const today = await w.image(w.writers.history, 23); // 只被今天的行引用
		const repOld = await w.image(w.writers.repush, 24); // 10-05 的原件里
		const repToday = await w.image(w.writers.repush, 25); // 今天的原件里
		await w.write("data", "history/2026-10-04.jsonl", imageLine(old.ref));
		await w.write("data", "history/2026-10-05.jsonl", imageLine(yest.ref));
		await w.write("data", "history/2026-10-06.jsonl", imageLine(today.ref));
		const snapOldBytes = await w.write(
			"data",
			"history/repush/2026-10-05/a.json",
			snapshot(repOld.ref),
		);
		await w.write("data", "history/repush/2026-10-06/b.json", snapshot(repToday.ref));

		const result = await w.storage.clear("historyImages");

		expect(result.freedBytes).toBe(snapOldBytes + old.size + yest.size + repOld.size);
		const left = await readdir(join(w.dataRoot, "images"));
		expect(left.sort()).toEqual([today.ref, repToday.ref].sort());
		expect(await w.namesIn(join(w.dataRoot, "history/repush"))).toEqual(["2026-10-06/b.json"]);
		// 文字一份没少。
		expect(await w.namesIn(join(w.dataRoot, "history"))).toEqual(
			expect.arrayContaining(["2026-10-04.jsonl", "2026-10-05.jsonl", "2026-10-06.jsonl"]),
		);
		expect(await readClearedThrough(w.dataRoot)).toBe("2026-10-05");
	});

	it("宽限期内的新图留着,freedBytes 不把它算进去", async () => {
		const w = world;
		const stale = await w.image(w.writers.history, 31);
		const fresh = await w.image(w.writers.history, 32, FRESH_MTIME);
		await w.write("data", "history/2026-10-04.jsonl", imageLine(stale.ref, fresh.ref));

		const result = await w.storage.clear("historyImages");

		expect(result.freedBytes).toBe(stale.size);
		expect(await readdir(join(w.dataRoot, "images"))).toEqual([fresh.ref]);
	});

	it("水位线只往前推:再清一次不会腾出新的东西,今天的图也不被连带", async () => {
		const w = world;
		const today = await w.image(w.writers.history, 33);
		await w.write("data", "history/2026-10-06.jsonl", imageLine(today.ref));
		await w.storage.clear("historyImages");
		expect(await w.storage.clear("historyImages")).toEqual({ freedBytes: 0 });
		expect(await readdir(join(w.dataRoot, "images"))).toEqual([today.ref]);
	});
});

describe("女仆 AI:对话与只被对话引用的图", () => {
	it("对话全删(含零消息的空壳与读不成 JSON 的坏文件),只被对话引用的图被清", async () => {
		const w = world;
		const only = await w.image(w.writers.chat, 41);
		const shared = await w.image(w.writers.chat, 42); // 同时被历史行引用
		const grace = await w.image(w.writers.chat, 43, FRESH_MTIME); // 宽限期内
		const convBytes =
			(await w.write(
				"data",
				"ai/conversations/a.json",
				chatFile(only.ref, shared.ref, grace.ref),
			)) +
			(await w.write("data", "ai/conversations/shell.json", JSON.stringify({ messages: [] }))) +
			(await w.write("data", "ai/conversations/broken.json", "{not json"));
		await w.write("data", "history/2026-10-06.jsonl", imageLine(shared.ref));

		const result = await w.storage.clear("ai");

		expect(await w.namesIn(join(w.dataRoot, "ai/conversations"))).toEqual([]);
		expect(result.freedBytes).toBe(convBytes + only.size);
		expect((await readdir(join(w.dataRoot, "images"))).sort()).toEqual(
			[shared.ref, grace.ref].sort(),
		);
	});
});

describe("推送历史的文字:日文件与重推原件一起删,水位线不动,图跟着清扫", () => {
	it("日文件与 repush/ 都空,retention.json 原样;只被这些行或原件引用且过了宽限期的图被收走,宽限期内的留着", async () => {
		const w = world;
		const only = await w.image(w.writers.history, 51);
		const shared = await w.image(w.writers.chat, 52); // 同时被对话引用:不该被收走
		const rep = await w.image(w.writers.repush, 53); // 只被原件引用:原件删了,图跟着收走
		const grace = await w.image(w.writers.repush, 54, FRESH_MTIME); // 宽限期内:留着
		const d1 = await w.write("data", "history/2026-10-04.jsonl", imageLine(only.ref));
		const d2 = await w.write("data", "history/2026-10-06.jsonl", imageLine(shared.ref));
		await w.write("data", "history/retention.json", `{"clearedThrough":"2026-10-01"}`);
		const s1 = await w.write("data", "history/repush/2026-10-04/r.json", snapshot(rep.ref));
		const s2 = await w.write("data", "history/repush/2026-10-06/r2.json", snapshot(grace.ref));
		await w.write("data", "ai/conversations/c.json", chatFile(shared.ref));

		const result = await w.storage.clear("historyText");

		expect(await w.namesIn(join(w.dataRoot, "history"))).toEqual(["retention.json"]);
		expect(await readClearedThrough(w.dataRoot)).toBe("2026-10-01");
		expect(result.freedBytes).toBe(d1 + d2 + s1 + s2 + only.size + rep.size);
		expect((await readdir(join(w.dataRoot, "images"))).sort()).toEqual(
			[shared.ref, grace.ref].sort(),
		);
		// 用量表:「推送历史的图」那一行里原件的部分归零(图的部分只剩宽限期内、已无人引用的那张,归其它图片)。
		const row = (await w.storage.list()).rows.find((r) => r.category === "historyImages");
		expect(row?.sizeBytes).toBe(0);
	});
});

describe("数据统计:四个目录、缓存", () => {
	it("四个目录的文件全清,运行记录不动;回的是实际字节;清完通知总览与粉丝轮询", async () => {
		const w = world;
		await w.file("data", "stats/posts/a.jsonl", 10);
		await w.file("data", "stats/live/a.jsonl", 20);
		await w.file("data", "stats/recording/a.jsonl", 30);
		await w.file("data", "stats/followers/a.jsonl", 40);
		await w.file("data", "stats/followers/b.jsonl", 5);
		await w.file("data", "uptime/hours.jsonl", 7);

		const result = await w.storage.clear("stats");

		expect(result.freedBytes).toBe(10 + 20 + 30 + 40 + 5);
		expect(await w.namesIn(join(w.dataRoot, "stats"))).toEqual([]);
		expect(await w.namesIn(join(w.dataRoot, "uptime"))).toEqual(["hours.jsonl"]);
		expect(w.invalidate).toHaveBeenCalledOnce();
		expect(w.pollerReset).toHaveBeenCalledOnce();
	});

	it("不碰订阅运行态里的资料", async () => {
		const w = world;
		const profile = { name: "n", sign: "", fans: 9, lastRefreshedAt: "2026-10-06T00:00:00.000Z" };
		await w.subscriptionStateStore.patch("sub-a", {
			cachedProfile: profile,
		});
		const secondProfile = { ...profile, name: "n2" };
		await w.subscriptionStateStore.patch("sub-b", {
			cachedProfile: secondProfile,
		});
		await w.subscriptionStateStore.patch("sub-c", { cachedProfile: profile });

		await w.storage.clear("stats");

		expect(w.subscriptionStateStore.get("sub-a")).toEqual({
			cachedProfile: profile,
		});
		expect(w.subscriptionStateStore.get("sub-b")).toEqual({ cachedProfile: secondProfile });
		expect(w.subscriptionStateStore.get("sub-c")).toEqual({ cachedProfile: profile });
		// 换一个仓从文件里读,这些格也原样还在。
		const reread = (await import("../subscription-state-store.js")).createSubscriptionStateStore({
			dataRoot: w.dataRoot,
			logger: { debug() {}, info() {}, warn() {}, error() {} },
		});
		await reread.load();
		expect(reread.get("sub-a")?.cachedProfile).toEqual(profile);
	});

	it("清的同时有排在队里的写(作品、粉丝样本、「在记」)和一场正在播的:清完什么都不会被写回来", async () => {
		const w = world;
		const key = "c0000000-0000-4000-8000-000000000001";
		w.recorder.recordPost(key, {
			id: "p",
			hasVideo: false,
			publishedAt: "2026-10-06T11:00:00.000Z",
		});
		w.recorder.recordReportedFollowers(key, 10, 0);
		w.recorder.recordActive(key, "posts");
		w.recorder.openSession(key, { startedAt: "2026-10-06T09:00:00.000Z" });

		await w.storage.clear("stats");
		w.recorder.closeSession(key, { endedAt: "2026-10-06T11:00:00.000Z" }); // 清空时开着的场次收尾:不写孤立的 end
		await w.recorder.flush();
		await new Promise((r) => setTimeout(r, 60));

		expect(await w.namesIn(join(w.dataRoot, "stats"))).toEqual([]);
	});

	it("总开关关着也能清(开关只管新数据记不记)", async () => {
		// 记录器那头的 isEnabled 在这个 world 里恒真;关着的情形由 stats/__tests__/recorder-clear.test.ts 钉。
		await world.file("data", "stats/posts/a.jsonl", 10);
		expect((await world.storage.clear("stats")).freedBytes).toBe(10);
	});
});

describe("手动清扫图库", () => {
	it("回删了几张、多少字节,以及留下的两种张数;不绕宽限期", async () => {
		const w = world;
		const gone1 = await w.image(w.writers.history, 61);
		const gone2 = await w.image(w.writers.history, 62);
		const kept = await w.image(w.writers.profiles, 63);
		w.profileRefs.push(kept.ref);
		await w.image(w.writers.history, 64, FRESH_MTIME);
		void OLD_MTIME;

		expect(await w.storage.sweepImages()).toEqual({
			removedCount: 2,
			removedBytes: gone1.size + gone2.size,
			referenced: 1,
			inGrace: 1,
		});
		expect(await w.storage.sweepImages()).toEqual({
			removedCount: 0,
			removedBytes: 0,
			referenced: 1,
			inGrace: 1,
		});
	});
});
