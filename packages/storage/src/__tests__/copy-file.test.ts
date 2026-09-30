/**
 * 持久化底层:复制与硬链接(迁移开新代用,ADR-0022 决策 7)。
 *
 * 追加写的文件(jsonl)一律复制 —— 硬链接的话新代往里追加会改到旧代的文件;其余能硬链接就链接,
 * 链接不了(跨分区、文件系统不支持)回落成复制。复制与原子写同一个套路:临时文件写完 fsync 再改名。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { copyFileAtomic, linkOrCopyFile } from "../copy-file";

const linkFailure = vi.hoisted(() => ({ code: undefined as string | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...real,
		link: async (...args: Parameters<typeof real.link>) => {
			if (linkFailure.code) {
				throw Object.assign(new Error(`link failed: ${linkFailure.code}`), {
					code: linkFailure.code,
				});
			}
			return real.link(...args);
		},
	};
});

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-copy-file-"));
	linkFailure.code = undefined;
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function source(content: string): Promise<string> {
	const path = join(dir, "from", "a.jsonl");
	await mkdir(join(dir, "from"), { recursive: true });
	await writeFile(path, content);
	return path;
}

describe("copyFileAtomic", () => {
	it("复制出一份独立的:内容一样、不是同一个文件,目标目录不存在就建", async () => {
		const from = await source("line 1\n");
		const to = join(dir, "to", "nested", "a.jsonl");

		await copyFileAtomic(from, to);

		expect(await readFile(to, "utf8")).toBe("line 1\n");
		expect((await stat(to)).ino).not.toBe((await stat(from)).ino);
		await writeFile(to, "line 1\nline 2\n");
		expect(await readFile(from, "utf8")).toBe("line 1\n");
	});

	it("不留临时文件", async () => {
		const from = await source("x");
		await copyFileAtomic(from, join(dir, "to", "a.jsonl"));

		expect(await readdir(join(dir, "to"))).toEqual(["a.jsonl"]);
	});
});

describe("linkOrCopyFile", () => {
	it("同一分区 → 硬链接,和来源是同一个文件", async () => {
		const from = await source("x");
		const to = join(dir, "to", "a.json");

		expect(await linkOrCopyFile(from, to)).toBe("linked");
		expect((await stat(to)).ino).toBe((await stat(from)).ino);
	});

	it.each(["EXDEV", "EPERM", "ENOTSUP", "EMLINK"])("链接失败(%s)→ 回落成复制", async (code) => {
		linkFailure.code = code;
		const from = await source("x");
		const to = join(dir, "to", "a.json");

		expect(await linkOrCopyFile(from, to)).toBe("copied");
		expect(await readFile(to, "utf8")).toBe("x");
		expect((await stat(to)).ino).not.toBe((await stat(from)).ino);
	});

	it("目标已经在了 → 抛出去,不悄悄盖掉", async () => {
		const from = await source("x");
		const to = join(dir, "to", "a.json");
		await mkdir(join(dir, "to"), { recursive: true });
		await writeFile(to, "keep");

		await expect(linkOrCopyFile(from, to)).rejects.toMatchObject({ code: "EEXIST" });
		expect(await readFile(to, "utf8")).toBe("keep");
	});
});
