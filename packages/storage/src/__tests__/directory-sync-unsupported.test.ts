import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { atomicWriteFile, atomicWriteFileSync } from "../atomic-file";

/**
 * 部分 NAS / SMB / FUSE 挂载不支持 fsync 目录(报 EINVAL、ENOTSUP 之类)。改名那一刻文件已经
 * 好好地在目标位置,这时把写入当成失败,挂在这类盘上的数据目录就每次写都「失败」。这里把
 * 「以只读打开的句柄 fsync」换成报指定的错,模拟那种文件系统。
 */
const dirSync = vi.hoisted(() => ({
	code: undefined as string | undefined,
	fds: new Set<number>(),
}));

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: 模拟的目录 fsync 失败`), { code });
}

vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...real,
		open: async (...args: Parameters<typeof real.open>) => {
			const handle = await real.open(...args);
			if (args[1] !== "r" || dirSync.code === undefined) return handle;
			const code = dirSync.code;
			return {
				sync: async () => {
					throw errno(code);
				},
				close: () => handle.close(),
			};
		},
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return {
		...real,
		openSync: (...args: Parameters<typeof real.openSync>) => {
			const fd = real.openSync(...args);
			if (args[1] === "r") dirSync.fds.add(fd);
			return fd;
		},
		fsyncSync: (fd: number) => {
			if (dirSync.code !== undefined && dirSync.fds.has(fd)) throw errno(dirSync.code);
			real.fsyncSync(fd);
		},
		closeSync: (fd: number) => {
			dirSync.fds.delete(fd);
			real.closeSync(fd);
		},
	};
});

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-dirsync-"));
	dirSync.code = undefined;
});

afterEach(async () => {
	dirSync.code = undefined;
	await rm(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("目录 fsync 不受支持", () => {
	for (const code of ["EINVAL", "ENOTSUP"]) {
		it(`报 ${code}:原子写照样成功,内容在目标位置,不留临时文件`, async () => {
			dirSync.code = code;
			await atomicWriteFile(join(dir, "a.json"), "一");
			atomicWriteFileSync(join(dir, "b.json"), "二");
			expect(await readFile(join(dir, "a.json"), "utf8")).toBe("一");
			expect(await readFile(join(dir, "b.json"), "utf8")).toBe("二");
			expect((await readdir(dir)).sort()).toEqual(["a.json", "b.json"]);
		});
	}

	it("别的错(EIO)照抛:那是盘真出了问题,不能当成没发生", async () => {
		dirSync.code = "EIO";
		await expect(atomicWriteFile(join(dir, "a.json"), "一")).rejects.toMatchObject({
			code: "EIO",
		});
		expect(() => atomicWriteFileSync(join(dir, "b.json"), "二")).toThrow(/EIO/);
	});
});
