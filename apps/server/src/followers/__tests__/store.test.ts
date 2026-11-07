/**
 * 单元测试 — `createFollowersStore`(真实 tmpdir FS)。
 *
 * 守护契约:
 *   - append:按需建粉丝时序目录 + 追加一行;多次 append 累积
 *   - findNearestBefore:前向扫描,返回 sampledAt<=target 的最近一条;遇首个 sampledAt>target 停止;
 *     坏行 / 空行 / 缺字段行跳过;目标早于所有样本 → undefined;文件缺失 → undefined(不 warn)
 *   - drop:删文件;缺文件时静默(不抛、不 warn)
 */

import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFollowersStore, FOLLOWERS_DIR, type FollowersStore } from "../store.js";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

let dataDir: string;
let logger: ReturnType<typeof makeLogger>;
let store: FollowersStore;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-fans-"));
	logger = makeLogger();
	store = createFollowersStore({ dataRoot: dataDir, logger });
});
afterEach(() => {
	vi.restoreAllMocks();
});

const T = (h: number) => `2026-05-16T${String(h).padStart(2, "0")}:00:00.000Z`;

describe("append", () => {
	it("按需建目录并追加 jsonl 行", async () => {
		await store.append("u1", { sampledAt: T(1), followers: 100 });
		await store.append("u1", { sampledAt: T(2), followers: 110 });
		const raw = await readFile(join(dataDir, ...FOLLOWERS_DIR, "u1.jsonl"), "utf8");
		const lines = raw.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] as string)).toEqual({ sampledAt: T(1), followers: 100 });
	});

	it("盘上逐字节:紧凑 JSON、一行一条、末尾换行,下一次追加接在后面", async () => {
		await store.append("u1", { sampledAt: T(1), followers: 100 });
		await store.append("u1", { sampledAt: T(2), followers: 110 });
		expect(await readFile(join(dataDir, ...FOLLOWERS_DIR, "u1.jsonl"), "utf8")).toBe(
			`{"sampledAt":"${T(1)}","followers":100}\n{"sampledAt":"${T(2)}","followers":110}\n`,
		);
	});

	it("目录里没有多余文件(不留临时名)", async () => {
		await store.append("u1", { sampledAt: T(1), followers: 100 });
		expect(await readdir(join(dataDir, ...FOLLOWERS_DIR))).toEqual(["u1.jsonl"]);
	});

	it("写不进去只 warn、不抛(键名对上的是个目录)", async () => {
		await mkdir(join(dataDir, ...FOLLOWERS_DIR, "u1.jsonl"), { recursive: true });
		await expect(store.append("u1", { sampledAt: T(1), followers: 100 })).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith("粉丝样本追加失败", {
			key: "u1",
			error: expect.any(Error),
		});
	});
});

describe("findNearestBefore", () => {
	beforeEach(async () => {
		await store.append("u1", { sampledAt: T(1), followers: 100 });
		await store.append("u1", { sampledAt: T(2), followers: 110 });
		await store.append("u1", { sampledAt: T(3), followers: 130 });
	});

	it("返回 sampledAt<=target 的最近一条(target 在样本之间)", async () => {
		expect(await store.findNearestBefore("u1", T(2) /* 不存在则取最近 */)).toEqual({
			sampledAt: T(2),
			followers: 110,
		});
		const between = await store.findNearestBefore("u1", "2026-05-16T02:30:00.000Z");
		expect(between).toEqual({ sampledAt: T(2), followers: 110 });
	});

	it("target 晚于所有样本 → 返回最后一条", async () => {
		expect(await store.findNearestBefore("u1", T(9))).toEqual({ sampledAt: T(3), followers: 130 });
	});

	it("target 早于所有样本 → undefined(首条即 > target,立即停止)", async () => {
		expect(await store.findNearestBefore("u1", T(0))).toBeUndefined();
	});

	it("文件缺失 → undefined 且不告警(ENOENT 属正常)", async () => {
		expect(await store.findNearestBefore("never-seen", T(5))).toBeUndefined();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("坏行 / 空行 / 缺字段行被跳过", async () => {
		await writeFile(
			join(dataDir, ...FOLLOWERS_DIR, "u2.jsonl"),
			`${[
				"{not json",
				"",
				JSON.stringify({ sampledAt: T(1) }), // 缺 followers
				JSON.stringify({ followers: 5 }), // 缺 sampledAt
				JSON.stringify({ sampledAt: T(2), followers: 200 }), // 合法
				"   ",
			].join("\n")}\n`,
			"utf8",
		);
		expect(await store.findNearestBefore("u2", T(5))).toEqual({ sampledAt: T(2), followers: 200 });
	});
});

describe("findEarliest", () => {
	beforeEach(async () => {
		// 粉丝时序目录由 append 内部 ensureRoot 创建;findEarliest 测试直接 writeFile
		// 不经 append,需要手动建目录避免 ENOENT。
		await mkdir(join(dataDir, ...FOLLOWERS_DIR), { recursive: true });
	});

	it("返回 jsonl 第一条有效样本(早返回,不扫整个文件)", async () => {
		await store.append("u1", { sampledAt: T(1), followers: 100 });
		await store.append("u1", { sampledAt: T(2), followers: 110 });
		await store.append("u1", { sampledAt: T(3), followers: 130 });
		expect(await store.findEarliest("u1")).toEqual({ sampledAt: T(1), followers: 100 });
	});

	it("文件不存在 → undefined 且不告警(ENOENT 属正常)", async () => {
		expect(await store.findEarliest("never-seen")).toBeUndefined();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("文件全是坏行 → undefined", async () => {
		await writeFile(
			join(dataDir, ...FOLLOWERS_DIR, "u2.jsonl"),
			["{not json", "", JSON.stringify({ sampledAt: T(1) }), "   "].join("\n"),
			"utf8",
		);
		expect(await store.findEarliest("u2")).toBeUndefined();
	});

	it("跳过开头的坏行,返回第一条合法样本", async () => {
		await writeFile(
			join(dataDir, ...FOLLOWERS_DIR, "u3.jsonl"),
			[
				"{not json",
				"",
				JSON.stringify({ sampledAt: T(2), followers: 200 }), // 第一条合法
				JSON.stringify({ sampledAt: T(3), followers: 300 }),
			].join("\n"),
			"utf8",
		);
		expect(await store.findEarliest("u3")).toEqual({ sampledAt: T(2), followers: 200 });
	});
});

describe("drop", () => {
	it("删除该 uid 文件", async () => {
		await store.append("u1", { sampledAt: T(1), followers: 1 });
		await store.drop("u1");
		expect(await store.findNearestBefore("u1", T(9))).toBeUndefined();
	});

	it("文件不存在时静默(不抛、不 warn)", async () => {
		await expect(store.drop("ghost")).resolves.toBeUndefined();
		expect(logger.warn).not.toHaveBeenCalled();
	});
});

describe("listSamplesSince", () => {
	it("返回 sampledAt >= since 的全部样本,按时间升序", async () => {
		await store.append("u1", { sampledAt: T(1), followers: 100 });
		await store.append("u1", { sampledAt: T(3), followers: 120 });
		await store.append("u1", { sampledAt: T(5), followers: 150 });
		expect(await store.listSamplesSince("u1", T(3))).toEqual([
			{ sampledAt: T(3), followers: 120 },
			{ sampledAt: T(5), followers: 150 },
		]);
	});

	it("since 早于所有样本 → 全量返回", async () => {
		await store.append("u1", { sampledAt: T(2), followers: 10 });
		await store.append("u1", { sampledAt: T(4), followers: 20 });
		expect(await store.listSamplesSince("u1", T(0))).toHaveLength(2);
	});

	it("坏行 / 空行 / 缺字段行跳过", async () => {
		await mkdir(join(dataDir, ...FOLLOWERS_DIR), { recursive: true });
		await writeFile(
			join(dataDir, ...FOLLOWERS_DIR, "u2.jsonl"),
			[
				"{not json",
				"",
				JSON.stringify({ sampledAt: T(1) }),
				JSON.stringify({ followers: 5 }),
				JSON.stringify({ sampledAt: T(2), followers: 200 }),
			].join("\n"),
			"utf8",
		);
		expect(await store.listSamplesSince("u2", T(0))).toEqual([{ sampledAt: T(2), followers: 200 }]);
	});

	it("文件缺失 → 空数组,不 warn", async () => {
		expect(await store.listSamplesSince("ghost", T(0))).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
	});
});

describe("读口对段正确(压缩过的文件)", () => {
	const put = (name: string, rows: unknown[]) =>
		mkdir(join(dataDir, ...FOLLOWERS_DIR), { recursive: true }).then(() =>
			writeFile(
				join(dataDir, ...FOLLOWERS_DIR, `${name}.jsonl`),
				`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
			),
		);
	const SEG = {
		sampledAt: "2026-05-10T00:20:00.000Z",
		followers: 50,
		lastSampledAt: "2026-05-10T04:40:00.000Z",
	};
	const AFTER = { sampledAt: "2026-05-10T06:10:00.000Z", followers: 60 };

	it("findNearestBefore:目标落在段里回这段的值,落在段后回段末,读口只回点", async () => {
		await put("seg", [SEG, AFTER]);
		expect(await store.findNearestBefore("seg", "2026-05-10T02:30:00.000Z")).toEqual({
			sampledAt: "2026-05-10T01:59:59.999Z",
			followers: 50,
		});
		expect(await store.findNearestBefore("seg", "2026-05-10T05:00:00.000Z")).toEqual({
			sampledAt: "2026-05-10T04:40:00.000Z",
			followers: 50,
		});
		expect(await store.findNearestBefore("seg", "2026-05-11T00:00:00.000Z")).toEqual(AFTER);
	});

	it("findEarliest 回段起点(不带 lastSampledAt)", async () => {
		await put("seg", [SEG, AFTER]);
		expect(await store.findEarliest("seg")).toEqual({
			sampledAt: "2026-05-10T00:20:00.000Z",
			followers: 50,
		});
	});

	it("listSamplesSince:段展开成每小时一个点并裁到窗口", async () => {
		await put("seg", [SEG, AFTER]);
		expect(await store.listSamplesSince("seg", "2026-05-10T02:00:00.000Z")).toEqual([
			{ sampledAt: "2026-05-10T02:59:59.999Z", followers: 50 },
			{ sampledAt: "2026-05-10T03:59:59.999Z", followers: 50 },
			{ sampledAt: "2026-05-10T04:40:00.000Z", followers: 50 },
			AFTER,
		]);
	});
});

describe("仓只认新形状", () => {
	it("0.x 的 { ts, value } 行读口一律当坏行跳过", async () => {
		await mkdir(join(dataDir, ...FOLLOWERS_DIR), { recursive: true });
		await writeFile(
			join(dataDir, ...FOLLOWERS_DIR, "old.jsonl"),
			`${JSON.stringify({ ts: T(1), value: 100 })}\n${JSON.stringify({ sampledAt: T(2), followers: 110 })}\n`,
		);
		expect(await store.findEarliest("old")).toEqual({ sampledAt: T(2), followers: 110 });
		expect(await store.listSamplesSince("old", T(0))).toEqual([
			{ sampledAt: T(2), followers: 110 },
		]);
	});

	it("append 只写两格,多带的键不进盘", async () => {
		await store.append("x", { sampledAt: T(1), followers: 1, extra: 1 } as never);
		expect(await readFile(join(dataDir, ...FOLLOWERS_DIR, "x.jsonl"), "utf8")).toBe(
			`{"sampledAt":"${T(1)}","followers":1}\n`,
		);
	});
});
