/**
 * 持久化底层:原子复制(迁移开新代用,ADR-0022 决策 7)。与原子写同一个套路:临时文件写完 fsync 再改名。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { copyFileAtomic } from "../copy-file";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-copy-file-"));
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
