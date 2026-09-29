import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { readBestEffortJson, writeBestEffortJson } from "../durable-json.js";

/**
 * 「启发式状态」的读写纪律(选版记账、防回放记忆、拓展失败记账、市场来源账本共用):
 * 两头都吞掉失败,读到坏文件改走改名隔离。用真实临时目录 —— 改名与 EISDIR 的语义在真文件系统上。
 */
const created: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "bn-durable-json-"));
	created.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readBestEffortJson", () => {
	it("文件在、是好 JSON → 读回解析后的值", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "state.json"), '{"a":1}');

		expect(readBestEffortJson(dir, "state.json")).toEqual({ a: 1 });
	});

	it("文件不在 → undefined,目录里也不多出任何东西", () => {
		const dir = tempDir();

		expect(readBestEffortJson(dir, "state.json")).toBeUndefined();
		expect(readdirSync(dir)).toEqual([]);
	});

	it("目录都不存在 → undefined(头一次开机本来就没有它)", () => {
		const dir = tempDir();

		expect(readBestEffortJson(join(dir, "not-yet"), "state.json")).toBeUndefined();
	});

	it("被写坏了 → undefined,而且坏文件被改名隔离:原内容一字不丢,原位置空出来", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "state.json"), "{ 半个 JSON");

		expect(readBestEffortJson(dir, "state.json")).toBeUndefined();

		expect(existsSync(join(dir, "state.json"))).toBe(false);
		const quarantined = readdirSync(dir).filter((name) => name.startsWith("state.json.corrupt-"));
		expect(quarantined).toHaveLength(1);
		expect(readFileSync(join(dir, quarantined[0] as string), "utf8")).toBe("{ 半个 JSON");
	});

	it("隔离之后再写落在原位置,不会把隔离的那份盖掉", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "state.json"), "{ 半个 JSON");
		readBestEffortJson(dir, "state.json");

		writeBestEffortJson(dir, "state.json", { fresh: true });

		expect(readBestEffortJson(dir, "state.json")).toEqual({ fresh: true });
		const quarantined = readdirSync(dir).filter((name) => name.startsWith("state.json.corrupt-"));
		expect(quarantined).toHaveLength(1);
		expect(readFileSync(join(dir, quarantined[0] as string), "utf8")).toBe("{ 半个 JSON");
	});

	it("读不动(路径是个目录)→ undefined,那个目录原样在、没被当成坏文件改名", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "state.json"));

		expect(readBestEffortJson(dir, "state.json")).toBeUndefined();

		expect(readdirSync(dir)).toEqual(["state.json"]);
		expect(statSync(join(dir, "state.json")).isDirectory()).toBe(true);
	});
});

describe("writeBestEffortJson", () => {
	it("落盘是 2 空格缩进、末尾换行的 JSON,读回与写入一致", () => {
		const dir = tempDir();
		const value = { attempts: { "0.9.0": 1 }, failed: [] as string[] };

		writeBestEffortJson(dir, "state.json", value);

		expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(
			`${JSON.stringify(value, null, 2)}\n`,
		);
		expect(readBestEffortJson(dir, "state.json")).toEqual(value);
	});

	it("目录不存在会建出来;写完不留临时文件", () => {
		const root = tempDir();
		const dir = join(root, "versions");

		writeBestEffortJson(dir, "state.json", { ok: true });

		expect(readdirSync(dir)).toEqual(["state.json"]);
	});

	it("覆盖已有的文件 —— 读到的是新内容", () => {
		const dir = tempDir();
		writeBestEffortJson(dir, "state.json", { n: 1 });
		writeBestEffortJson(dir, "state.json", { n: 2 });

		expect(readBestEffortJson(dir, "state.json")).toEqual({ n: 2 });
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});

	it("写不进去(根是个文件)→ 不抛,原因交给 onError;不给 onError 也不抛", () => {
		const root = tempDir();
		writeFileSync(join(root, "blocker"), "我是文件,不是目录");
		const errors: unknown[] = [];

		expect(() =>
			writeBestEffortJson(join(root, "blocker", "x"), "state.json", {}, (err) => errors.push(err)),
		).not.toThrow();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(Error);

		expect(() => writeBestEffortJson(join(root, "blocker", "x"), "state.json", {})).not.toThrow();
	});

	it("目标位置被一个目录占着 → 不抛、交出原因,而且不留临时文件", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "state.json"));
		const errors: unknown[] = [];

		writeBestEffortJson(dir, "state.json", { a: 1 }, (err) => errors.push(err));

		expect(errors).toHaveLength(1);
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});
});
