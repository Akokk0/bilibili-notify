/**
 * **统计记录器的整类清空 `clear()`**(㉙d;删盘,与只清内存的 `reset()` 不同)。
 *
 * 真仓、真文件(自己建的临时目录)。要证明的:
 * - 排在队里的在飞写入(作品、粉丝样本、「在记」)清完不会被重新写出来 —— 包括队里有、盘上还没有文件的键;
 * - 清空时正在播的场次不留半场:之后的下播不写孤立的 `end`;清空之后新开的场次照常记;
 * - 总开关关着也能清。
 * 每条「没有文件」的断言都配一条「不清就有」的对照,免得什么都没发生时空绿。
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { createFollowersStore } from "../../followers/store.js";
import { createStatsRecorderCore } from "../recorder.js";
import { createStatsStore } from "../store.js";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const KEY = "b0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000002";

let dataRoot: string;
let enabled: boolean;
beforeEach(async () => {
	dataRoot = await mkdtemp(join(tmpdir(), "bn-recorder-clear-"));
	enabled = true;
});
afterEach(async () => {
	await rm(dataRoot, { recursive: true, force: true });
});

function setup() {
	const store = createStatsStore({ dataRoot, logger: silentLogger });
	const fans = createFollowersStore({ dataRoot, logger: silentLogger });
	const core = createStatsRecorderCore({
		store,
		fans,
		logger: silentLogger,
		now: () => new Date(NOW),
		isEnabled: () => enabled,
	});
	return { store, fans, core };
}

async function statsFiles(): Promise<string[]> {
	const out: string[] = [];
	for (const dir of ["posts", "live", "recording", "followers"]) {
		try {
			for (const name of await readdir(join(dataRoot, "stats", dir))) out.push(`${dir}/${name}`);
		} catch {
			// 目录还没建
		}
	}
	return out.sort();
}

const post = (id: string) => ({ id, hasVideo: false, publishedAt: "2026-10-06T11:00:00.000Z" });
const delay = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

describe("整类清空 × 排在队里的写", () => {
	it("对照:不清,同样的写都会落盘", async () => {
		const { core } = setup();
		core.recordPost(KEY, post("p1"));
		core.recordFans(KEY, 100, 0);
		core.recordActive(KEY, "posts");
		await core.flush();
		expect(await statsFiles()).toEqual([
			`followers/${KEY}.jsonl`,
			`posts/${KEY}.jsonl`,
			`recording/${KEY}.jsonl`,
		]);
	});

	it("在飞的作品、粉丝样本、「在记」排在清空前面,清完文件不会被写回来", async () => {
		const { core } = setup();
		// 作品写入还没落盘时清空就开始了;这个键盘上一个文件都没有(只在队里)。
		core.recordPost(KEY, post("p1"));
		core.recordFans(KEY, 100, 0);
		core.recordActive(KEY, "posts");
		core.recordPost(OTHER, post("p2"));

		await core.clear();
		expect(await statsFiles()).toEqual([]);
		// 再等一等:没有任何迟到的写把文件带回来。
		await core.flush();
		await delay(60, null);
		expect(await statsFiles()).toEqual([]);
	});

	it("盘上本来就有的各类文件都清,没有文件也成功", async () => {
		const { core, store, fans } = setup();
		await store.appendPost(KEY, post("p1"));
		await store.openLiveSession(KEY, "2026-10-06T09:00:00.000Z");
		await store.appendRecording(OTHER, {
			kind: "live",
			startedAt: "2026-10-06T09:00:00.000Z",
			endedAt: "2026-10-06T10:00:00.000Z",
		});
		await fans.append(OTHER, { sampledAt: "2026-10-06T09:00:00.000Z", followers: 1 });
		expect((await statsFiles()).length).toBe(4);
		await core.clear();
		expect(await statsFiles()).toEqual([]);
		await expect(core.clear()).resolves.toBeUndefined();
	});

	it("总开关关着也能清", async () => {
		const { core, store } = setup();
		await store.appendPost(KEY, post("p1"));
		enabled = false;
		await core.clear();
		expect(await statsFiles()).toEqual([]);
	});

	it("清空会忘掉「这个小时已经记过」:之后同一个小时的账能重新写出一行", async () => {
		const { core, store } = setup();
		core.recordActive(KEY, "posts");
		await core.flush();
		await core.clear();
		core.recordActive(KEY, "posts");
		await core.flush();
		expect((await store.listRecording(KEY, "")).length).toBe(1);
	});
});

describe("整类清空 × 正在播的场次", () => {
	it("对照:不清,开场再下播写出一对帧", async () => {
		const { core, store } = setup();
		core.openSession(KEY, "2026-10-06T09:00:00.000Z");
		core.closeSession(KEY, "2026-10-06T11:00:00.000Z");
		await core.flush();
		expect(await store.listLiveSessions(KEY, "")).toEqual([
			{ startedAt: "2026-10-06T09:00:00.000Z", endedAt: "2026-10-06T11:00:00.000Z" },
		]);
	});

	it("清空时开着的场次:之后的下播不写孤立的 end,盘上一个文件都不留", async () => {
		const { core } = setup();
		core.openSession(KEY, "2026-10-06T09:00:00.000Z");
		await core.clear();
		core.closeSession(KEY, "2026-10-06T11:00:00.000Z");
		await core.flush();
		expect(await statsFiles()).toEqual([]);
	});

	it("清空之后新开的场次是真的:头尾都记,不被「被清掉的那场」吞掉", async () => {
		const { core, store } = setup();
		core.openSession(KEY, "2026-10-06T09:00:00.000Z");
		await core.clear();
		core.openSession(KEY, "2026-10-06T10:00:00.000Z");
		core.closeSession(KEY, "2026-10-06T11:00:00.000Z");
		await core.flush();
		expect(await store.listLiveSessions(KEY, "")).toEqual([
			{ startedAt: "2026-10-06T10:00:00.000Z", endedAt: "2026-10-06T11:00:00.000Z" },
		]);
	});

	it("清空时开着的场次,关停补帧也不再给它补(没有可补的开播帧)", async () => {
		const { core } = setup();
		core.openSession(KEY, "2026-10-06T09:00:00.000Z");
		await core.clear();
		await core.closeOpenSessions();
		expect(await statsFiles()).toEqual([]);
	});

	it("别的键清空时没开着的场次,下播照常写(只吞被清掉的那几场)", async () => {
		const { core, store } = setup();
		core.openSession(KEY, "2026-10-06T09:00:00.000Z");
		await core.clear();
		// OTHER 在清空之后才下播,它的开播帧在重启前的盘上 —— 这里造一个盘上有开播帧的场景。
		await store.openLiveSession(OTHER, "2026-10-06T08:00:00.000Z");
		core.closeSession(OTHER, "2026-10-06T11:00:00.000Z");
		await core.flush();
		expect(await store.listLiveSessions(OTHER, "")).toEqual([
			{ startedAt: "2026-10-06T08:00:00.000Z", endedAt: "2026-10-06T11:00:00.000Z" },
		]);
	});
});
