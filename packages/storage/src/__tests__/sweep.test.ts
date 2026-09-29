import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { tempPathFor } from "../atomic-file";
import { isLeftoverName, sweepTempFiles } from "../sweep";

/**
 * 开机清扫:上个进程被杀时留下的临时文件与暂存目录删掉;整目录替换换到一半留下的旧目录,
 * 目标不在就挪回去、在就删掉。别的文件一概不碰。开机在任何写入开始之前跑一次。
 */

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-sweep-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function tree(root: string): Promise<string[]> {
	const out: string[] = [];
	for (const e of await readdir(root, { withFileTypes: true, recursive: true })) {
		out.push(join(e.parentPath, e.name).slice(root.length + 1));
	}
	return out.sort();
}

describe("sweepTempFiles", () => {
	it("各层里残留的临时文件与暂存目录删掉,别的原样", async () => {
		await mkdir(join(dir, "config"), { recursive: true });
		await writeFile(join(dir, "config", "settings.json"), "{}");
		await writeFile(join(dir, "config", "settings.json.bn-tmp.7.abcdef"), "{");
		await mkdir(join(dir, "skins", "card", "s1.bn-tmp.7.123456", "assets"), { recursive: true });
		await writeFile(join(dir, "skins", "card", "s1.bn-tmp.7.123456", "assets", "a.png"), "x");
		await writeFile(join(dir, "notes.bn-tmp.txt"), "不是我们的临时文件名,标记后面不是 pid");
		await writeFile(join(dir, "a.json.bn-tmpX7.abcdef"), "标记里的点得按字面认,不是任意字符");
		const report = await sweepTempFiles(dir);
		expect(await tree(dir)).toEqual([
			"a.json.bn-tmpX7.abcdef",
			"config",
			"config/settings.json",
			"notes.bn-tmp.txt",
			"skins",
			"skins/card",
		]);
		expect(report.removed.sort()).toEqual([
			join(dir, "config", "settings.json.bn-tmp.7.abcdef"),
			join(dir, "skins", "card", "s1.bn-tmp.7.123456"),
		]);
	});

	it("换目录换到一半:目标不在 → 旧的挪回去;目标在 → 旧的删掉", async () => {
		await mkdir(join(dir, "a.bn-old.7.aaaaaa"), { recursive: true });
		await writeFile(join(dir, "a.bn-old.7.aaaaaa", "f"), "旧 a");
		await mkdir(join(dir, "b"), { recursive: true });
		await writeFile(join(dir, "b", "f"), "新 b");
		await mkdir(join(dir, "b.bn-old.7.bbbbbb"), { recursive: true });
		const report = await sweepTempFiles(dir);
		expect(await readFile(join(dir, "a", "f"), "utf8")).toBe("旧 a");
		expect(await readFile(join(dir, "b", "f"), "utf8")).toBe("新 b");
		expect((await readdir(dir)).sort()).toEqual(["a", "b"]);
		expect(report.restored).toEqual([join(dir, "a")]);
	});

	it("根目录不存在 → 什么都不做", async () => {
		expect(await sweepTempFiles(join(dir, "nope"))).toEqual({ removed: [], restored: [] });
	});

	it("原子写真的会起的临时名,清扫认得", async () => {
		const leftover = tempPathFor(join(dir, "a.json"));
		await writeFile(leftover, "{");
		expect((await sweepTempFiles(dir)).removed).toEqual([leftover]);
	});
});

/**
 * 「开机扫一遍子目录建索引」的地方(皮肤库这类)用它跳过原语留下的暂存 / 旧目录,
 * 不用各自手写 `endsWith(".tmp")`。
 */
describe("isLeftoverName", () => {
	it("原语起的临时名 / 旧目录名 → true", () => {
		expect(isLeftoverName("s1.bn-tmp.7.abcdef")).toBe(true);
		expect(isLeftoverName("s1.bn-old.7.abcdef")).toBe(true);
		expect(isLeftoverName(tempPathFor("s1"))).toBe(true); // 原语真起的名字
	});

	it("名字里含标记就算(不要求落在末尾)", () => {
		expect(isLeftoverName("settings.json.bn-tmp.7.abcdef.extra")).toBe(true);
		expect(isLeftoverName(".bn-old.")).toBe(true);
	});

	it("普通名字 → false,包括长得像却不含完整标记的", () => {
		expect(isLeftoverName("s1")).toBe(false);
		expect(isLeftoverName("s1.tmp")).toBe(false);
		expect(isLeftoverName("s1.bn-tmp")).toBe(false);
		expect(isLeftoverName("bn-tmp.s1")).toBe(false);
		expect(isLeftoverName("a.bn-tmpX7.abcdef")).toBe(false);
		expect(isLeftoverName("a.bnXold.7.abcdef")).toBe(false);
		expect(isLeftoverName(".staging-1.2.0-aaaa")).toBe(false);
		expect(isLeftoverName("")).toBe(false);
	});
});
