import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * `atomicWriteFile` 的 `syncDirectory: false`:成批往新目录里写的调用方不逐个同步目录(迁移往新代图库落图)。
 * 文件本身照样原子写(临时文件 + fsync + 改名,不留临时文件);只是少一次对目录的 fsync。
 * 数「对目录开只读句柄」的次数——目录 fsync 就是这么做的。
 */

const dirOpens = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: (async (...args: Parameters<typeof actual.open>) => {
			if (args[1] === "r") dirOpens.paths.push(String(args[0]));
			return actual.open(...args);
		}) as typeof actual.open,
	};
});

import { atomicWriteFile } from "../atomic-file";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-atomic-bulk-"));
	dirOpens.paths.length = 0;
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("atomicWriteFile 的 syncDirectory 选项", () => {
	it("缺省:写完同步一次目录", async () => {
		await atomicWriteFile(join(dir, "a.bin"), new Uint8Array([1, 2, 3]));
		expect(dirOpens.paths).toEqual([dir]);
	});

	it("false:不同步目录;文件照样原样落下、不留临时文件", async () => {
		await atomicWriteFile(join(dir, "a.bin"), new Uint8Array([1, 2, 3]), { syncDirectory: false });
		await atomicWriteFile(join(dir, "b.bin"), "文字", { syncDirectory: false });
		expect(dirOpens.paths).toEqual([]);
		expect((await readdir(dir)).sort()).toEqual(["a.bin", "b.bin"]);
		expect(new Uint8Array(await readFile(join(dir, "a.bin")))).toEqual(new Uint8Array([1, 2, 3]));
		expect(await readFile(join(dir, "b.bin"), "utf8")).toBe("文字");
	});
});
