import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { appendJsonl, appendLines } from "../append-jsonl";

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

	it("序列化不出 JSON 的记录 → 抛 TypeError 点出第几条,整批一行都不写", async () => {
		const path = join(dir, "x.jsonl");
		await expect(appendJsonl(path, [{ a: 1 }, undefined])).rejects.toThrow(/第 1 条/);
		await expect(appendJsonl(path, [() => 0])).rejects.toBeInstanceOf(TypeError);
		expect(await readdir(dir)).toEqual([]);
	});
});

/**
 * 按原样追加行:调用方(日志)自己序列化,带循环引用兜底,这里只管把每个元素当一行、
 * 按原字节接在末尾。
 */
describe("appendLines", () => {
	it("每个元素一行、按原字节接在末尾;父目录不存在就建", async () => {
		const path = join(dir, "logs", "2026-09-29.jsonl");
		await appendLines(path, ['{"a":1}', "not json, kept as is", "二"]);
		await appendLines(path, ['{"c":true}']);
		expect(await readFile(path, "utf8")).toBe('{"a":1}\nnot json, kept as is\n二\n{"c":true}\n');
	});

	it("接在已有内容后面", async () => {
		const path = join(dir, "x.jsonl");
		await writeFile(path, "first\n");
		await appendLines(path, ["second"]);
		expect(await readFile(path, "utf8")).toBe("first\nsecond\n");
	});

	it("空数组什么都不做,不建文件", async () => {
		await appendLines(join(dir, "x.jsonl"), []);
		expect(await readdir(dir)).toEqual([]);
	});

	it("任何一个元素里含换行 → 抛 TypeError,整批一行都不写、不建文件", async () => {
		const path = join(dir, "x.jsonl");
		await expect(appendLines(path, ["ok", "a\nb"])).rejects.toThrow(TypeError);
		expect(await readdir(dir)).toEqual([]);
		await writeFile(path, "kept\n");
		await expect(appendLines(path, ["ok", "a\r\nb"])).rejects.toThrow(TypeError);
		expect(await readFile(path, "utf8")).toBe("kept\n");
	});
});
