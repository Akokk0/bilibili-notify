import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { appendJsonl } from "../append-jsonl";

/** 持久化底层:追加 JSONL(历史、统计、日志)。一次调用的几条一次写完,一条一行。 */

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-jsonl-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("appendJsonl", () => {
	it("一条一行接在末尾;父目录不存在就建", async () => {
		const path = join(dir, "stats", "posts", "s1.jsonl");
		await appendJsonl(path, [{ a: 1 }, { b: "二" }]);
		await appendJsonl(path, [{ c: true }]);
		expect(await readFile(path, "utf8")).toBe('{"a":1}\n{"b":"二"}\n{"c":true}\n');
	});

	it("空数组什么都不做,不建文件", async () => {
		await appendJsonl(join(dir, "x.jsonl"), []);
		expect(await readdir(dir)).toEqual([]);
	});
});
