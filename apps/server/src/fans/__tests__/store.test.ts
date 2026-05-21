/**
 * 单元测试 — `createFansStore`(真实 tmpdir FS)。
 *
 * 守护契约:
 *   - append:按需建 fans 目录 + 追加一行;多次 append 累积
 *   - findNearestBefore:前向扫描,返回 ts<=target 的最近一条;遇首个 ts>target 停止;
 *     坏行 / 空行 / 缺字段行跳过;目标早于所有样本 → undefined;文件缺失 → undefined(不 warn)
 *   - dropUid:删文件;缺文件时静默(不抛、不 warn)
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFansStore, type FansStore } from "../store.js";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

let dataDir: string;
let logger: ReturnType<typeof makeLogger>;
let store: FansStore;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-fans-"));
	logger = makeLogger();
	store = createFansStore({ dataDir, logger });
});
afterEach(() => {
	vi.restoreAllMocks();
});

const T = (h: number) => `2026-05-16T${String(h).padStart(2, "0")}:00:00.000Z`;

describe("append", () => {
	it("按需建目录并追加 jsonl 行", async () => {
		await store.append("u1", { ts: T(1), value: 100 });
		await store.append("u1", { ts: T(2), value: 110 });
		const raw = await readFile(join(dataDir, "fans", "u1.jsonl"), "utf8");
		const lines = raw.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] as string)).toEqual({ ts: T(1), value: 100 });
	});
});

describe("findNearestBefore", () => {
	beforeEach(async () => {
		await store.append("u1", { ts: T(1), value: 100 });
		await store.append("u1", { ts: T(2), value: 110 });
		await store.append("u1", { ts: T(3), value: 130 });
	});

	it("返回 ts<=target 的最近一条(target 在样本之间)", async () => {
		expect(await store.findNearestBefore("u1", T(2) /* 不存在则取最近 */)).toEqual({
			ts: T(2),
			value: 110,
		});
		const between = await store.findNearestBefore("u1", "2026-05-16T02:30:00.000Z");
		expect(between).toEqual({ ts: T(2), value: 110 });
	});

	it("target 晚于所有样本 → 返回最后一条", async () => {
		expect(await store.findNearestBefore("u1", T(9))).toEqual({ ts: T(3), value: 130 });
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
			join(dataDir, "fans", "u2.jsonl"),
			`${[
				"{not json",
				"",
				JSON.stringify({ ts: T(1) }), // 缺 value
				JSON.stringify({ value: 5 }), // 缺 ts
				JSON.stringify({ ts: T(2), value: 200 }), // 合法
				"   ",
			].join("\n")}\n`,
			"utf8",
		);
		expect(await store.findNearestBefore("u2", T(5))).toEqual({ ts: T(2), value: 200 });
	});
});

describe("findEarliest", () => {
	beforeEach(async () => {
		// fans/ 目录由 append 内部 ensureRoot 创建;findEarliest 测试直接 writeFile
		// 不经 append,需要手动建目录避免 ENOENT。
		await mkdir(join(dataDir, "fans"), { recursive: true });
	});

	it("返回 jsonl 第一条有效样本(早返回,不扫整个文件)", async () => {
		await store.append("u1", { ts: T(1), value: 100 });
		await store.append("u1", { ts: T(2), value: 110 });
		await store.append("u1", { ts: T(3), value: 130 });
		expect(await store.findEarliest("u1")).toEqual({ ts: T(1), value: 100 });
	});

	it("文件不存在 → undefined 且不告警(ENOENT 属正常)", async () => {
		expect(await store.findEarliest("never-seen")).toBeUndefined();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("文件全是坏行 → undefined", async () => {
		await writeFile(
			join(dataDir, "fans", "u2.jsonl"),
			["{not json", "", JSON.stringify({ ts: T(1) }), "   "].join("\n"),
			"utf8",
		);
		expect(await store.findEarliest("u2")).toBeUndefined();
	});

	it("跳过开头的坏行,返回第一条合法样本", async () => {
		await writeFile(
			join(dataDir, "fans", "u3.jsonl"),
			[
				"{not json",
				"",
				JSON.stringify({ ts: T(2), value: 200 }), // 第一条合法
				JSON.stringify({ ts: T(3), value: 300 }),
			].join("\n"),
			"utf8",
		);
		expect(await store.findEarliest("u3")).toEqual({ ts: T(2), value: 200 });
	});
});

describe("dropUid", () => {
	it("删除该 uid 文件", async () => {
		await store.append("u1", { ts: T(1), value: 1 });
		await store.dropUid("u1");
		expect(await store.findNearestBefore("u1", T(9))).toBeUndefined();
	});

	it("文件不存在时静默(不抛、不 warn)", async () => {
		await expect(store.dropUid("ghost")).resolves.toBeUndefined();
		expect(logger.warn).not.toHaveBeenCalled();
	});
});
