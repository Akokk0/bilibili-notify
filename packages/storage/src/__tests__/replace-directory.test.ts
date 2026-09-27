import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { replaceDirectory } from "../replace-directory";

/**
 * 持久化底层:整目录替换(皮肤包、拓展安装)。在旁边搭好新目录再整体换上去,
 * 读的一方看到的要么是整份旧的、要么是整份新的。
 */

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-replace-dir-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function seedOld(target: string) {
	await mkdir(target, { recursive: true });
	await writeFile(join(target, "old.txt"), "old");
}

describe("replaceDirectory", () => {
	it("整份换成新的;旧的与暂存都不留", async () => {
		const target = join(dir, "skins", "s1");
		await seedOld(target);
		await replaceDirectory(target, async (staging) => {
			await writeFile(join(staging, "manifest.json"), "{}");
		});
		expect(await readdir(target)).toEqual(["manifest.json"]);
		expect(await readdir(join(dir, "skins"))).toEqual(["s1"]);
	});

	it("目标原本不存在 → 建出来", async () => {
		const target = join(dir, "skins", "s1");
		await replaceDirectory(target, async (staging) => {
			await writeFile(join(staging, "a"), "1");
		});
		expect(await readFile(join(target, "a"), "utf8")).toBe("1");
	});

	it("搭建失败 → 抛出错误,原目录原样不动,暂存删掉", async () => {
		const target = join(dir, "skins", "s1");
		await seedOld(target);
		const boom = new Error("解包失败");
		await expect(
			replaceDirectory(target, async (staging) => {
				await writeFile(join(staging, "half"), "x");
				throw boom;
			}),
		).rejects.toBe(boom);
		expect(await readdir(target)).toEqual(["old.txt"]);
		expect(await readdir(join(dir, "skins"))).toEqual(["s1"]);
	});
});
