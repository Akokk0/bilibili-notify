/**
 * 粉丝仓的排队写与压缩(ADR-0027 决策 8、15;㉘c):`compact` / `close` / `keys`。
 *
 * 压缩与轮询的追加写同一个文件,所以走同一条按键的队:压缩进行中追加的样本压完还在。
 * 「压缩进行中」用存储层写函数前的闸停住(见 `support/storage-write-gate.ts`)。
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import { createFollowersStore, FOLLOWERS_DIR, type FollowersStore } from "../store.js";

vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
const NOW = new Date("2026-06-30T12:00:00.000Z"); // 切线 = 2026-06-22T12:00:00Z

let dataDir: string;
let log: ReturnType<typeof logger>;
let store: FollowersStore;
const fileOf = (key: string) => join(dataDir, ...FOLLOWERS_DIR, `${key}.jsonl`);
const lines = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const point = (sampledAt: string, followers: number) => ({ sampledAt, followers });

beforeEach(async () => {
	storageWriteGate.reset();
	dataDir = await mkdtemp(join(tmpdir(), "bn-followers-compact-"));
	await mkdir(join(dataDir, ...FOLLOWERS_DIR), { recursive: true });
	log = logger();
	store = createFollowersStore({ dataRoot: dataDir, logger: log });
});
afterEach(async () => {
	storageWriteGate.reset();
	await rm(dataDir, { recursive: true, force: true });
});

/** 旧点:00 / 01 / 02 点各一个同值 100(00 点那小时有两条),03 点 105;切线之后两条原样。 */
const RAW = [
	point("2026-06-10T00:10:00.000Z", 100),
	point("2026-06-10T00:50:00.000Z", 100),
	point("2026-06-10T01:20:00.000Z", 100),
	point("2026-06-10T02:05:00.000Z", 100),
	point("2026-06-10T03:00:00.000Z", 105),
	point("2026-06-29T10:00:00.000Z", 200),
	point("2026-06-29T10:10:00.000Z", 201),
];
const COMPACTED =
	'{"sampledAt":"2026-06-10T00:50:00.000Z","followers":100,"lastSampledAt":"2026-06-10T02:05:00.000Z"}\n' +
	'{"sampledAt":"2026-06-10T03:00:00.000Z","followers":105}\n' +
	'{"sampledAt":"2026-06-29T10:00:00.000Z","followers":200}\n' +
	'{"sampledAt":"2026-06-29T10:10:00.000Z","followers":201}\n';

describe("compact", () => {
	it("按 ㉘b 的规则压:旧的同值小时合成段、同一小时只留最晚的,切线之后原样;回报压掉了几行", async () => {
		await writeFile(fileOf("u1"), lines(RAW));
		const report = await store.compact("u1", NOW);
		expect(await readFile(fileOf("u1"), "utf8")).toBe(COMPACTED);
		expect(report).toEqual({ rowsBefore: 7, rowsAfter: 4, badLines: 0, rewritten: true });
	});

	it("幂等:第二次逐行相同,什么都不写(写次数不涨、文件字节不变)", async () => {
		await writeFile(fileOf("u1"), lines(RAW));
		await store.compact("u1", NOW);
		const writes = storageWriteGate.writes;
		const mtime = (await stat(fileOf("u1"))).mtimeMs;
		const report = await store.compact("u1", NOW);
		expect(report).toEqual({ rowsBefore: 4, rowsAfter: 4, badLines: 0, rewritten: false });
		expect(storageWriteGate.writes).toBe(writes);
		expect((await stat(fileOf("u1"))).mtimeMs).toBe(mtime);
		expect(await readFile(fileOf("u1"), "utf8")).toBe(COMPACTED);
	});

	it("坏行(不是 JSON / 0.x 的旧形状 / 缺格)丢掉并计数,空行不算;丢了坏行就记一条带计数的日志", async () => {
		await writeFile(
			fileOf("u1"),
			`{not json\n${JSON.stringify({ ts: "2026-06-10T00:10:00.000Z", value: 1 })}\n\n${lines([point("2026-06-29T10:00:00.000Z", 200)])}${JSON.stringify({ followers: 3 })}\n`,
		);
		const report = await store.compact("u1", NOW);
		expect(report).toEqual({ rowsBefore: 1, rowsAfter: 1, badLines: 3, rewritten: true });
		expect(await readFile(fileOf("u1"), "utf8")).toBe(
			'{"sampledAt":"2026-06-29T10:00:00.000Z","followers":200}\n',
		);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith("粉丝样本压缩时丢弃损坏行", { key: "u1", badLines: 3 });
	});

	it("文件不在:回全 0、不建文件、不告警", async () => {
		expect(await store.compact("ghost", NOW)).toEqual({
			rowsBefore: 0,
			rowsAfter: 0,
			badLines: 0,
			rewritten: false,
		});
		await expect(stat(fileOf("ghost"))).rejects.toThrow();
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("压缩进行中追加的样本,压完还在(追加排在压缩后面,落在压缩结果之后)", async () => {
		await writeFile(fileOf("u1"), lines(RAW));
		storageWriteGate.hold();
		const compacting = store.compact("u1", NOW);
		await storageWriteGate.arrived(); // 压缩已读完整份、停在原子写的闸门口
		const appending = store.append("u1", point("2026-06-30T11:50:00.000Z", 250));
		storageWriteGate.release();
		await Promise.all([compacting, appending]);
		expect(await readFile(fileOf("u1"), "utf8")).toBe(
			`${COMPACTED}{"sampledAt":"2026-06-30T11:50:00.000Z","followers":250}\n`,
		);
	});

	it("追加在先、压缩在后:压缩把它也算进去", async () => {
		await writeFile(fileOf("u1"), lines(RAW));
		const appending = store.append("u1", point("2026-06-10T03:30:00.000Z", 105));
		const compacting = store.compact("u1", NOW);
		await Promise.all([appending, compacting]);
		// 03 点那小时有两条 105,留最晚的 03:30。
		expect(await readFile(fileOf("u1"), "utf8")).toBe(
			`${COMPACTED.replace('"2026-06-10T03:00:00.000Z"', '"2026-06-10T03:30:00.000Z"')}`,
		);
	});

	it("不同的键互不排队:一个键的压缩停在闸门口,不挡另一个键的读", async () => {
		await writeFile(fileOf("u1"), lines(RAW));
		await writeFile(fileOf("u2"), lines([point("2026-06-29T10:00:00.000Z", 7)]));
		storageWriteGate.hold();
		const compacting = store.compact("u1", NOW);
		await storageWriteGate.arrived();
		expect(await store.findEarliest("u2")).toEqual(point("2026-06-29T10:00:00.000Z", 7));
		storageWriteGate.release();
		await compacting;
	});
});

describe("keys", () => {
	it("列出盘上的 `.jsonl` 文件的键,别的文件不算", async () => {
		await writeFile(fileOf("b"), "");
		await writeFile(fileOf("a"), "");
		await writeFile(join(dataDir, ...FOLLOWERS_DIR, "readme.txt"), "");
		expect((await store.keys()).sort()).toEqual(["a", "b"]);
	});

	it("目录还没建:空数组", async () => {
		const fresh = createFollowersStore({ dataRoot: join(dataDir, "none"), logger: log });
		expect(await fresh.keys()).toEqual([]);
	});
});

describe("close", () => {
	it("关门之后的写与压缩一律被拒、不碰盘", async () => {
		await writeFile(fileOf("u1"), lines(RAW));
		await store.close();
		const writes = storageWriteGate.writes;
		await expect(store.append("u1", point("2026-06-30T11:50:00.000Z", 1))).rejects.toMatchObject({
			code: "queue_closed",
		});
		await expect(store.compact("u1", NOW)).rejects.toMatchObject({ code: "queue_closed" });
		await expect(store.drop("u1")).rejects.toMatchObject({ code: "queue_closed" });
		expect(storageWriteGate.writes).toBe(writes);
		expect(await readFile(fileOf("u1"), "utf8")).toBe(lines(RAW));
	});

	it("关门要等在途的写落盘:压缩停在闸门口时 close 还没返回,放闸后文件是压缩后的", async () => {
		await writeFile(fileOf("u1"), lines(RAW));
		storageWriteGate.hold();
		const compacting = store.compact("u1", NOW);
		await storageWriteGate.arrived();
		let closed = false;
		const closing = store.close().then(() => {
			closed = true;
		});
		await new Promise((r) => setTimeout(r, 30));
		expect(closed).toBe(false);
		storageWriteGate.release();
		await closing;
		await compacting;
		expect(await readFile(fileOf("u1"), "utf8")).toBe(COMPACTED);
	});
});
