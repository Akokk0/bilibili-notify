import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { migrateSubscriptionState } from "../subscription-state.js";

const BILI_A = "11111111-1111-4111-8111-111111111111";
const BILI_B = "22222222-2222-4222-8222-222222222222";
const EXT_A = "33333333-3333-4333-8333-333333333333";
const ORPHAN = "44444444-4444-4444-8444-444444444444";
const AVATAR = `${"a".repeat(64)}.png`;

let dataRoot: string;

const profile = (overrides: Record<string, unknown> = {}) => ({
	name: "阿绫",
	avatar: AVATAR,
	sign: "旧签名",
	fans: 42,
	fanClubName: "阿绫的粉丝团",
	lastRefreshedAt: "2026-10-24T00:00:00.000Z",
	...overrides,
});

const statePath = () => join(dataRoot, "runtime", "subscription-state.json");
const biliStatePath = () => join(dataRoot, "runtime", "bilibili", "state.json");

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value));
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

const biliSubscriptions = (...rows: { id: string; uid: string }[]) => rows;

beforeEach(async () => {
	dataRoot = await mkdtemp(join(tmpdir(), "bn-subscription-state-migration-"));
});

afterEach(async () => {
	await rm(dataRoot, { recursive: true, force: true });
});

describe("订阅资料迁移", () => {
	it("资料改成 CreatorProfile 形状,记录只剩资料,B 站房号拆进自己的状态文件", async () => {
		await writeJson(statePath(), {
			[BILI_A]: {
				roomId: "5050",
				fansBaseline: { value: 10, ts: "2026-10-01T00:00:00.000Z" },
				followed: true,
				followError: "old",
				cachedProfile: {
					...profile(),
					avatarUrl: "https://i0.hdslb.com/bfs/face/a.jpg",
					unknown: "drop",
				},
				unknownRecord: "drop",
			},
		});
		await writeJson(biliStatePath(), {
			version: 1,
			entries: {
				"http.identity": { ua: "kept", headers: {} },
				"room:999": "999",
			},
		});

		const report = await migrateSubscriptionState({
			dataRoot,
			biliSubscriptions: biliSubscriptions({ id: BILI_A, uid: "12345" }),
		});

		expect(await readJson(statePath())).toEqual({
			[BILI_A]: {
				cachedProfile: {
					name: "阿绫",
					avatar: AVATAR,
					bio: "旧签名",
					followers: 42,
					fanClubName: "阿绫的粉丝团",
					refreshedAt: "2026-10-24T00:00:00.000Z",
				},
			},
		});
		expect(await readJson(biliStatePath())).toEqual({
			version: 1,
			entries: {
				"http.identity": { ua: "kept", headers: {} },
				"room:999": "999",
				"room:12345": "5050",
			},
		});
		expect(report.rewritten.map((path) => path.replace(`${dataRoot}/`, ""))).toEqual([
			"runtime/subscription-state.json",
			"runtime/bilibili/state.json",
		]);
	});

	it("空简介缺键、数字房号转字符串,非法房号跳过", async () => {
		await writeJson(statePath(), {
			[BILI_A]: { roomId: 5050, cachedProfile: profile({ sign: "" }) },
			[BILI_B]: { roomId: "0", cachedProfile: profile({ name: "乙" }) },
		});

		const report = await migrateSubscriptionState({
			dataRoot,
			biliSubscriptions: biliSubscriptions(
				{ id: BILI_A, uid: "12345" },
				{ id: BILI_B, uid: "67890" },
			),
		});

		const runtime = (await readJson(statePath())) as Record<
			string,
			{ cachedProfile?: Record<string, unknown> }
		>;
		expect(runtime[BILI_A]?.cachedProfile).not.toHaveProperty("bio");
		expect(await readJson(biliStatePath())).toEqual({
			version: 1,
			entries: { "room:12345": "5050" },
		});
		expect(report.summary.invalidRooms).toBe(1);
	});

	it("拓展与孤儿记录的房号不导出;没有有效房号就不建 B 站状态文件", async () => {
		await writeJson(statePath(), {
			[EXT_A]: { roomId: "5050", cachedProfile: profile({ name: "拓展甲" }) },
			[ORPHAN]: { roomId: "6060", cachedProfile: profile({ name: "孤儿" }) },
		});

		const report = await migrateSubscriptionState({
			dataRoot,
			biliSubscriptions: [],
		});

		await expect(readFile(biliStatePath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(report.summary.unmappedRooms).toBe(2);
	});

	it("同一 uid 第一条没房号时,按订阅文件顺序取后一条有效房号", async () => {
		await writeJson(statePath(), {
			[BILI_A]: { cachedProfile: profile() },
			[BILI_B]: { roomId: "6060", cachedProfile: profile({ name: "乙" }) },
		});

		const report = await migrateSubscriptionState({
			dataRoot,
			biliSubscriptions: biliSubscriptions(
				{ id: BILI_A, uid: "12345" },
				{ id: BILI_B, uid: "12345" },
			),
		});

		expect(await readJson(biliStatePath())).toEqual({
			version: 1,
			entries: { "room:12345": "6060" },
		});
		expect(report.summary.duplicateUids).toBe(0);
	});

	it("同一 uid 已写过房号后,后续重复的有效房号不再写入", async () => {
		await writeJson(statePath(), {
			[BILI_A]: { roomId: "5050", cachedProfile: profile() },
			[BILI_B]: { roomId: "6060", cachedProfile: profile({ name: "乙" }) },
		});

		const report = await migrateSubscriptionState({
			dataRoot,
			biliSubscriptions: biliSubscriptions(
				{ id: BILI_A, uid: "12345" },
				{ id: BILI_B, uid: "12345" },
			),
		});

		expect(await readJson(biliStatePath())).toEqual({
			version: 1,
			entries: { "room:12345": "5050" },
		});
		expect(report.summary.duplicateUids).toBe(1);
	});

	it("资料过不了 schema 就丢掉,没有资料的记录整条删", async () => {
		await writeJson(statePath(), {
			[BILI_A]: { roomId: "5050", cachedProfile: profile({ refreshedAt: "wrong", name: 42 }) },
			[BILI_B]: { roomId: "6060" },
			bare: { fansBaseline: { value: 1, ts: "t" } },
		});

		const report = await migrateSubscriptionState({
			dataRoot,
			biliSubscriptions: biliSubscriptions(
				{ id: BILI_A, uid: "12345" },
				{ id: BILI_B, uid: "67890" },
			),
		});

		expect(await readJson(statePath())).toEqual({});
		expect(report.summary.droppedProfiles).toBe(1);
		expect(report.summary.droppedRecords).toBe(3);
		expect(await readJson(biliStatePath())).toEqual({
			version: 1,
			entries: { "room:12345": "5050", "room:67890": "6060" },
		});
	});

	it("资料缓存读不成 JSON 时跳过并报告,不抛也不覆盖", async () => {
		await mkdir(dirname(statePath()), { recursive: true });
		await writeFile(statePath(), "{ not json");

		const report = await migrateSubscriptionState({
			dataRoot,
			biliSubscriptions: biliSubscriptions({ id: BILI_A, uid: "12345" }),
		});

		expect(report.rewritten).toEqual([]);
		expect(report.skipped.map((entry) => entry.path)).toContain("runtime/subscription-state.json");
		expect(await readFile(statePath(), "utf8")).toBe("{ not json");
	});

	it("已有 B 站状态文件读不懂时资料照迁,但不覆盖房号状态", async () => {
		await writeJson(statePath(), {
			[BILI_A]: { roomId: "5050", cachedProfile: profile() },
		});
		await mkdir(dirname(biliStatePath()), { recursive: true });
		await writeFile(biliStatePath(), "{ not json");

		const report = await migrateSubscriptionState({
			dataRoot,
			biliSubscriptions: biliSubscriptions({ id: BILI_A, uid: "12345" }),
		});

		expect((await readJson(statePath())) as Record<string, unknown>).toHaveProperty(BILI_A);
		expect(await readFile(biliStatePath(), "utf8")).toBe("{ not json");
		expect(report.skipped.map((entry) => entry.path)).toContain("runtime/bilibili/state.json");
	});

	it("已有 B 站状态文件超过集成限额时跳过房号,资料照迁", async () => {
		await writeJson(statePath(), {
			[BILI_A]: { roomId: "5050", cachedProfile: profile() },
		});
		const original = JSON.stringify({
			version: 1,
			entries: { bloated: "x".repeat(1024 * 1024) },
		});
		await mkdir(dirname(biliStatePath()), { recursive: true });
		await writeFile(biliStatePath(), original);

		const report = await migrateSubscriptionState({
			dataRoot,
			biliSubscriptions: biliSubscriptions({ id: BILI_A, uid: "12345" }),
		});

		expect((await readJson(statePath())) as Record<string, unknown>).toHaveProperty(BILI_A);
		expect(await readFile(biliStatePath(), "utf8")).toBe(original);
		expect(report.summary.roomsWritten).toBe(0);
		expect(report.rewritten.map((path) => path.replace(`${dataRoot}/`, ""))).toEqual([
			"runtime/subscription-state.json",
		]);
		expect(report.skipped.map((entry) => entry.path)).toContain("runtime/bilibili/state.json");
	});
});
