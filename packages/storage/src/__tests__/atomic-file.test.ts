import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { atomicWriteFile, atomicWriteJson } from "../atomic-file";

/**
 * 持久化底层:原子写。都在真实的临时目录里跑,不桩文件系统 —— 要钉的正是「盘上最后长什么样」。
 */

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-atomic-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("atomicWriteJson", () => {
	it("写成 2 空格缩进、末尾换行;父目录不存在就建", async () => {
		const path = join(dir, "config", "settings.json");
		await atomicWriteJson(path, { a: 1, b: ["x"] });
		expect(await readFile(path, "utf8")).toBe('{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}\n');
		expect(await readdir(join(dir, "config"))).toEqual(["settings.json"]);
	});

	it("改名失败:抛出错误,临时文件删掉,原来的东西原样不动", async () => {
		const path = join(dir, "state.json");
		await mkdir(path); // 目标位置被一个目录占着,改名必失败
		await writeFile(join(path, "keep"), "old");
		await expect(atomicWriteJson(path, { a: 1 })).rejects.toThrow();
		expect(await readdir(dir)).toEqual(["state.json"]);
		expect(await readFile(join(path, "keep"), "utf8")).toBe("old");
	});

	it("同一个目标并发写:落下的是其中一份完整内容,不留临时文件", async () => {
		const path = join(dir, "state.json");
		const values = Array.from({ length: 20 }, (_, i) => ({ i, pad: "x".repeat(i * 100) }));
		await Promise.all(values.map((v) => atomicWriteJson(path, v)));
		const landed = JSON.parse(await readFile(path, "utf8"));
		expect(values).toContainEqual(landed);
		expect(await readdir(dir)).toEqual(["state.json"]);
	});

	it.skipIf(process.platform === "win32")("mode:新文件按给的权限位建", async () => {
		const path = join(dir, "secrets", "master.key");
		await atomicWriteJson(path, "k", { mode: 0o600 });
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});
});

describe("atomicWriteFile", () => {
	it("字节原样写;覆盖已有文件", async () => {
		const path = join(dir, "img.bin");
		await writeFile(path, "old");
		const bytes = new Uint8Array([0, 255, 1, 254]);
		await atomicWriteFile(path, bytes);
		expect(new Uint8Array(await readFile(path))).toEqual(bytes);
	});
});
