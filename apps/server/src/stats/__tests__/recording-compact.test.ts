/**
 * 「在记」账的压缩(ADR-0027 决策 13、15;㉘d):仓的 `compactRecording` / `recordingKeys`,与记录器的
 * `compactRecording(now)`(压缩与账的追加走记录器同一条按键的队,不会交错)。
 *
 * 「压缩进行中」用存储层写函数前的闸停住(见 `support/storage-write-gate.ts`)。
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import { createStatsRecorderCore } from "../recorder.js";
import { createStatsStore, STATS_RECORDING_DIR, type StatsStore } from "../store.js";

vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
const NOW = new Date("2026-06-30T12:00:00.000Z"); // 切线 = 2026-06-22T12:00:00Z

let dataDir: string;
let log: ReturnType<typeof logger>;
let store: StatsStore;
const fileOf = (key: string) => join(dataDir, ...STATS_RECORDING_DIR, `${key}.jsonl`);
const row = (kind: string, startedAt: string, endedAt: string) =>
	JSON.stringify({ kind, startedAt, endedAt });
const lines = (rows: string[]) => `${rows.join("\n")}\n`;
/** 2026-06-10 的 `h` 点整。 */
const H = (h: number, day = 10) =>
	`2026-06-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;

beforeEach(async () => {
	storageWriteGate.reset();
	dataDir = await mkdtemp(join(tmpdir(), "bn-recording-compact-"));
	await mkdir(join(dataDir, ...STATS_RECORDING_DIR), { recursive: true });
	log = logger();
	store = createStatsStore({ dataRoot: dataDir, logger: log });
});
afterEach(async () => {
	storageWriteGate.reset();
	await rm(dataDir, { recursive: true, force: true });
});

/** 06-10:posts 00–01、01–02 首尾相接,05–06 隔开;live 00–01;切线之后(06-29)posts 10–11、11–12 原样不合。 */
const RAW = [
	row("posts", H(0), H(1)),
	row("posts", H(1), H(2)),
	row("posts", H(5), H(6)),
	row("live", H(0), H(1)),
	row("posts", H(10, 29), H(11, 29)),
	row("posts", H(11, 29), H(12, 29)),
];
const COMPACTED = lines([
	row("live", H(0), H(1)),
	row("posts", H(0), H(2)),
	row("posts", H(5), H(6)),
	row("posts", H(10, 29), H(11, 29)),
	row("posts", H(11, 29), H(12, 29)),
]);

describe("store.compactRecording", () => {
	it("按 ㉘b 的规则压:切线前同项首尾相接的合成一段,切线之后原样;回报压掉了几行", async () => {
		await writeFile(fileOf("u1"), lines(RAW));
		const report = await store.compactRecording("u1", NOW);
		expect(await readFile(fileOf("u1"), "utf8")).toBe(COMPACTED);
		expect(report).toEqual({ rowsBefore: 6, rowsAfter: 5, badLines: 0, rewritten: true });
	});

	it("幂等:第二次逐行相同,什么都不写(写次数不涨、文件字节不变)", async () => {
		await writeFile(fileOf("u1"), lines(RAW));
		await store.compactRecording("u1", NOW);
		const writes = storageWriteGate.writes;
		const mtime = (await stat(fileOf("u1"))).mtimeMs;
		expect(await store.compactRecording("u1", NOW)).toEqual({
			rowsBefore: 5,
			rowsAfter: 5,
			badLines: 0,
			rewritten: false,
		});
		expect(storageWriteGate.writes).toBe(writes);
		expect((await stat(fileOf("u1"))).mtimeMs).toBe(mtime);
	});

	it("坏行(不是 JSON / 缺格 / 不认的项 / 起止倒置)丢掉并计数,空行不算;记一条带计数的日志", async () => {
		await writeFile(
			fileOf("u1"),
			`{not json\n${row("posts", H(1), H(0))}\n${row("what", H(0), H(1))}\n\n${JSON.stringify({ kind: "posts" })}\n${lines([row("posts", H(10, 29), H(11, 29))])}`,
		);
		const report = await store.compactRecording("u1", NOW);
		expect(report).toEqual({ rowsBefore: 1, rowsAfter: 1, badLines: 4, rewritten: true });
		expect(await readFile(fileOf("u1"), "utf8")).toBe(lines([row("posts", H(10, 29), H(11, 29))]));
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(String(log.warn.mock.calls[0]?.[0])).toMatch(/u1.*4/);
	});

	it("文件不在:回全 0、不建文件、不告警", async () => {
		expect(await store.compactRecording("ghost", NOW)).toEqual({
			rowsBefore: 0,
			rowsAfter: 0,
			badLines: 0,
			rewritten: false,
		});
		await expect(stat(fileOf("ghost"))).rejects.toThrow();
		expect(log.warn).not.toHaveBeenCalled();
	});
});

describe("store.recordingKeys", () => {
	it("列出盘上的 `.jsonl` 账文件的键,别的文件不算;目录还没建回空", async () => {
		await writeFile(fileOf("b"), "");
		await writeFile(fileOf("a"), "");
		await writeFile(join(dataDir, ...STATS_RECORDING_DIR, "x.txt"), "");
		expect((await store.recordingKeys()).sort()).toEqual(["a", "b"]);
		const fresh = createStatsStore({ dataRoot: join(dataDir, "none"), logger: log });
		expect(await fresh.recordingKeys()).toEqual([]);
	});
});

describe("recorder.compactRecording", () => {
	let clock: Date;
	const makeRecorder = () =>
		createStatsRecorderCore({
			isEnabled: () => true,
			store,
			fans: {} as never,
			logger: log,
			now: () => clock,
		});
	beforeEach(() => {
		clock = NOW;
	});

	it("对盘上每份账各压一遍,回汇总(改写了几个文件、压掉几行、丢几条坏行)", async () => {
		await writeFile(fileOf("u1"), lines(RAW));
		await writeFile(fileOf("u2"), lines([row("posts", H(10, 29), H(11, 29))]));
		await writeFile(fileOf("u3"), `{bad\n${lines(RAW)}`);
		const summary = await makeRecorder().compactRecording(NOW);
		expect(summary).toEqual({ files: 2, squeezed: 2, badLines: 1 });
		expect(await readFile(fileOf("u1"), "utf8")).toBe(COMPACTED);
	});

	it("压缩进行中记的小时,压完还在:追加排在压缩后面,落在压缩结果之后", async () => {
		await writeFile(fileOf("u1"), lines(RAW));
		const recorder = makeRecorder();
		storageWriteGate.hold();
		const compacting = recorder.compactRecording(NOW);
		await storageWriteGate.arrived(); // 压缩读完了整份、停在原子写的闸门口
		recorder.recordActive("u1", "followers", NOW.getTime());
		storageWriteGate.release();
		await compacting;
		await recorder.flush();
		expect(await readFile(fileOf("u1"), "utf8")).toBe(
			`${COMPACTED}${row("followers", H(12, 30), "2026-06-30T13:00:00.000Z")}\n`,
		);
	});

	it("追加在先、压缩在后:压缩把新行也算进去", async () => {
		await writeFile(fileOf("u1"), lines(RAW));
		const recorder = makeRecorder();
		// 06-29 12:00–13:00 的 posts 与已有的 11–12 首尾相接,但都在切线之后,不合;压缩回写时这一行还在。
		recorder.recordActive("u1", "posts", Date.parse("2026-06-29T12:30:00.000Z"));
		await recorder.compactRecording(NOW);
		await recorder.flush();
		expect(await readFile(fileOf("u1"), "utf8")).toBe(
			`${COMPACTED}${row("posts", H(12, 29), H(13, 29))}\n`,
		);
	});

	describe("重启后第一次写某个键前读盘、把这个小时已有的种进去", () => {
		it("盘上已有一行长区间盖着这个小时(迁移写的就是长区间):不再落第二行", async () => {
			const long = row("posts", "2026-06-27T00:00:00.000Z", "2026-06-30T13:00:00.000Z");
			await writeFile(fileOf("u1"), lines([long]));
			const recorder = makeRecorder();
			recorder.recordActive("u1", "posts", NOW.getTime());
			await recorder.flush();
			expect(await readFile(fileOf("u1"), "utf8")).toBe(lines([long]));
		});

		it("压缩之后(长区间在切线之后、原样留着)再记同一小时:仍然不落第二行", async () => {
			const long = row("posts", "2026-06-27T00:00:00.000Z", "2026-06-30T13:00:00.000Z");
			await writeFile(
				fileOf("u1"),
				lines([long, row("posts", H(0), H(1)), row("posts", H(1), H(2))]),
			);
			const recorder = makeRecorder();
			await recorder.compactRecording(NOW);
			recorder.recordActive("u1", "posts", NOW.getTime());
			recorder.recordActive("u1", "live", NOW.getTime());
			await recorder.flush();
			expect(await readFile(fileOf("u1"), "utf8")).toBe(
				lines([row("posts", H(0), H(2)), long, row("live", H(12, 30), "2026-06-30T13:00:00.000Z")]),
			);
		});
	});
});
