import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { quarantineFileSync, readJsonFile, readJsonFileSync } from "../read-json";

/**
 * 持久化底层:读 JSON。三种结果分开交代 —— 不在、读到了、坏了;坏文件改名成
 * `.corrupt-<时刻>` 隔离,原内容一字不丢,下一次写入不会把它盖掉。要不要因此开机报错
 * 由调用方定(配置文件报错,缓存类当空)。
 */

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-read-json-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("readJsonFile", () => {
	it("文件不在 → missing", async () => {
		expect(await readJsonFile(join(dir, "nope.json"))).toEqual({ kind: "missing" });
	});

	it("读到了 → ok 带值", async () => {
		const path = join(dir, "a.json");
		await writeFile(path, '{"a":1}');
		expect(await readJsonFile(path)).toEqual({ kind: "ok", value: { a: 1 } });
	});

	it("坏了 → 改名隔离,原内容一字不丢,原位置空出来", async () => {
		const path = join(dir, "a.json");
		await writeFile(path, '{"a":1,');
		const result = await readJsonFile(path);
		expect(result.kind).toBe("corrupt");
		if (result.kind !== "corrupt") return;
		expect(basename(result.quarantinedPath)).toMatch(
			/^a\.json\.corrupt-\d{4}-\d{2}-\d{2}T[\d-]+Z$/,
		);
		expect(await readFile(result.quarantinedPath, "utf8")).toBe('{"a":1,');
		expect(await readdir(dir)).toEqual([basename(result.quarantinedPath)]);
	});
});

describe("readJsonFileSync", () => {
	it("文件不在 → missing", () => {
		expect(readJsonFileSync(join(dir, "nope.json"))).toEqual({ kind: "missing" });
	});

	it("读到了 → ok 带值", async () => {
		const path = join(dir, "a.json");
		await writeFile(path, '{"a":1}');
		expect(readJsonFileSync(path)).toEqual({ kind: "ok", value: { a: 1 } });
	});

	it("坏了 → 改名隔离,原内容一字不丢,原位置空出来", async () => {
		const path = join(dir, "a.json");
		await writeFile(path, '{"a":1,');
		const result = readJsonFileSync(path);
		expect(result.kind).toBe("corrupt");
		if (result.kind !== "corrupt") return;
		expect(basename(result.quarantinedPath)).toMatch(
			/^a\.json\.corrupt-\d{4}-\d{2}-\d{2}T[\d-]+Z$/,
		);
		expect(await readFile(result.quarantinedPath, "utf8")).toBe('{"a":1,');
		expect(await readdir(dir)).toEqual([basename(result.quarantinedPath)]);
	});

	it("文件在但读不了(EISDIR,非 ENOENT)→ 抛,不当成 missing", async () => {
		await mkdir(join(dir, "a.json"));
		expect(() => readJsonFileSync(join(dir, "a.json"))).toThrow(/EISDIR/);
	});
});

describe("quarantineFileSync", () => {
	it("改名成 <原名>.corrupt-<时刻>,返回新路径", async () => {
		const path = join(dir, "b.json");
		await writeFile(path, "schema 不认的内容");
		const moved = quarantineFileSync(path);
		expect(basename(moved)).toMatch(/^b\.json\.corrupt-\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
		expect(await readFile(moved, "utf8")).toBe("schema 不认的内容");
		expect(await readdir(dir)).toEqual([basename(moved)]);
	});
});
