/**
 * 载荷里的更新说明:读 `release-notes.json`,以及「两版之间跨过了哪几版」。
 *
 * - 数据文件在 → 读出;不在、读不懂 → 空表,日志说清原因(开发版缺文件不出声)。
 * - `releasesBetween`:`from < v ≤ to`,新的在前,版本先后按 `compareVersions`;
 *   同号的正式版盖掉它自己的预发布段(范围里同时有 1.1.0 与 1.1.0-alpha.N 只列 1.1.0)。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readReleaseNotes, releasesBetween } from "../release-notes.js";

const note = (version: string) => ({ version, summary: `概述 ${version}` });
const versionsOf = (entries: readonly { version: string }[]) => entries.map((e) => e.version);

describe("releasesBetween", () => {
	const all = ["1.0.0", "1.0.1", "1.1.0"].map(note);

	it("只给 from 之后、到 to 为止的,新的在前", () => {
		expect(versionsOf(releasesBetween(all, "1.0.0", "1.1.0"))).toEqual(["1.1.0", "1.0.1"]);
		expect(versionsOf(releasesBetween(all, "1.0.0", "1.0.1"))).toEqual(["1.0.1"]);
	});

	it("from 与 to 一样 → 空;文件里的次序不影响结果", () => {
		expect(releasesBetween(all, "1.0.1", "1.0.1")).toEqual([]);
		expect(versionsOf(releasesBetween([...all].reverse(), "0.0.0", "1.1.0"))).toEqual([
			"1.1.0",
			"1.0.1",
			"1.0.0",
		]);
	});

	it("版本先后按 compareVersions:1.10 在 1.9 之后,alpha.10 在 alpha.9 之后", () => {
		const entries = ["1.9.0", "1.10.0", "1.11.0-alpha.9", "1.11.0-alpha.10"].map(note);
		expect(versionsOf(releasesBetween(entries, "1.9.0", "1.11.0-alpha.10"))).toEqual([
			"1.11.0-alpha.10",
			"1.11.0-alpha.9",
			"1.10.0",
		]);
	});

	it("范围里有正式版时,它自己的预发布段不给", () => {
		const entries = ["1.0.0", "1.1.0-alpha.1", "1.1.0-alpha.2", "1.1.0"].map(note);
		expect(versionsOf(releasesBetween(entries, "1.0.0", "1.1.0"))).toEqual(["1.1.0"]);
	});

	it("正式版不在范围里(to 就是预发布)时,预发布段照给;别的号的预发布段不受影响", () => {
		const entries = ["1.0.0", "1.1.0-alpha.1", "1.1.0-alpha.2", "1.1.0", "1.2.0-alpha.1"].map(note);
		expect(versionsOf(releasesBetween(entries, "1.0.0", "1.1.0-alpha.2"))).toEqual([
			"1.1.0-alpha.2",
			"1.1.0-alpha.1",
		]);
		expect(versionsOf(releasesBetween(entries, "1.0.0", "1.2.0-alpha.1"))).toEqual([
			"1.2.0-alpha.1",
			"1.1.0",
		]);
	});

	it("0.x 升 1.0:从 0.0.0 数起,只有 1.0.0 那一段(它的 alpha 被盖掉)", () => {
		const entries = ["1.0.0-alpha.1", "1.0.0-alpha.2", "1.0.0"].map(note);
		expect(versionsOf(releasesBetween(entries, "0.0.0", "1.0.0"))).toEqual(["1.0.0"]);
	});
});

describe("readReleaseNotes", () => {
	let dir: string;
	let logger: { warn: ReturnType<typeof vi.fn> };
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bn-release-notes-"));
		logger = { warn: vi.fn() };
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const read = (runningVersion = "1.0.0") =>
		readReleaseNotes({ payloadDir: dir, runningVersion, logger: logger as unknown as Logger });

	it("数据文件在 → 原样读出", async () => {
		const releases = [
			{ version: "1.1.0", date: "2026-11-01", summary: "**新**", caution: "⚠️ 先看这段" },
			{ version: "1.0.0", summary: "第一版" },
		];
		await writeFile(join(dir, "release-notes.json"), JSON.stringify({ releases }));

		expect(await read()).toEqual(releases);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("不在 → 空表,日志里说缺了文件", async () => {
		expect(await read()).toEqual([]);
		expect(logger.warn).toHaveBeenCalledOnce();
		expect(String(logger.warn.mock.calls[0]?.[0])).toContain("release-notes.json");
	});

	it("开发版缺文件 → 空表,不出声", async () => {
		expect(await read("0.0.0-dev")).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("读不懂(不是 JSON / 形状不对)→ 空表,日志里带原因", async () => {
		await writeFile(join(dir, "release-notes.json"), "{not json");
		expect(await read()).toEqual([]);
		await writeFile(
			join(dir, "release-notes.json"),
			JSON.stringify({ releases: [{ version: 1 }] }),
		);
		expect(await read()).toEqual([]);
		expect(logger.warn).toHaveBeenCalledTimes(2);
	});
});
