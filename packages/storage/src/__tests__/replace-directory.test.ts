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

/**
 * 可指定名字:载荷目录 `versions/` 的暂存名 `.staging-<版本>-<uuid>` / `.old-<版本>-<uuid>`
 * 已经被发出去的代码认着,不能换成默认的 `.bn-tmp.*` / `.bn-old.*`。
 */
describe("replaceDirectory — 自定义暂存 / 旧目录名", () => {
	it("build 拿到的就是给的暂存路径;换完后暂存与旧的都不留", async () => {
		const versions = join(dir, "versions");
		const target = join(versions, "1.2.0");
		const stagingPath = join(versions, ".staging-1.2.0-aaaa");
		const oldPath = join(versions, ".old-1.2.0-aaaa");
		await seedOld(target);
		let seen: string | undefined;
		await replaceDirectory(
			target,
			async (staging) => {
				seen = staging;
				await writeFile(join(staging, "boot.mjs"), "new");
			},
			{ stagingPath, oldPath },
		);
		expect(seen).toBe(stagingPath);
		expect(await readdir(target)).toEqual(["boot.mjs"]);
		expect(await readdir(versions)).toEqual(["1.2.0"]);
	});

	it("只给旧目录的名:暂存仍走默认的 .bn-tmp. 名(不给的那个不受影响)", async () => {
		const versions = join(dir, "versions");
		const target = join(versions, "1.2.0");
		await seedOld(target);
		let seen: string | undefined;
		await replaceDirectory(
			target,
			async (staging) => {
				seen = staging;
			},
			{ oldPath: join(versions, ".old-1.2.0-bbbb") },
		);
		expect(seen).toMatch(/1\.2\.0\.bn-tmp\.\d+\.[0-9a-f]+$/);
		expect(await readdir(versions)).toEqual(["1.2.0"]);
	});

	it("旧目录改成给的名字:那个名字被占着(非空目录)→ 抛错,原目录不动,暂存删掉", async () => {
		// 换到一半才用得上旧名字,看不见中间态;让它被一个非空目录占着,改名必失败 ——
		// 默认的随机旧名不会撞上,所以这条只有真的用了给的旧名才会红。
		const versions = join(dir, "versions");
		const target = join(versions, "1.2.0");
		const oldPath = join(versions, ".old-1.2.0-cccc");
		await seedOld(target);
		await mkdir(oldPath);
		await writeFile(join(oldPath, "squatter"), "x");
		await expect(
			replaceDirectory(
				target,
				async (staging) => {
					await writeFile(join(staging, "new.txt"), "n");
				},
				{ oldPath },
			),
		).rejects.toThrow();
		expect(await readdir(target)).toEqual(["old.txt"]);
		expect(await readdir(oldPath)).toEqual(["squatter"]);
		expect((await readdir(versions)).sort()).toEqual([".old-1.2.0-cccc", "1.2.0"]);
	});

	it("搭建失败:给了暂存名也照样删掉暂存,原目录不动", async () => {
		const versions = join(dir, "versions");
		const target = join(versions, "1.2.0");
		const stagingPath = join(versions, ".staging-1.2.0-dddd");
		await seedOld(target);
		await expect(
			replaceDirectory(
				target,
				async (staging) => {
					await writeFile(join(staging, "half"), "x");
					throw new Error("boom");
				},
				{ stagingPath },
			),
		).rejects.toThrow("boom");
		expect(await readdir(versions)).toEqual(["1.2.0"]);
		expect(await readdir(target)).toEqual(["old.txt"]);
	});

	it("名字不与目标同一个父目录 → 抛 TypeError,而且在碰盘之前:build 没跑、什么都没建", async () => {
		const target = join(dir, "versions", "1.2.0");
		await seedOld(target);
		const elsewhere = join(dir, "elsewhere");
		let built = false;
		const build = async () => {
			built = true;
		};
		for (const opts of [
			{ stagingPath: join(elsewhere, ".staging-x") },
			{ oldPath: join(elsewhere, ".old-x") },
			{ stagingPath: join(dir, "versions", "deeper", ".staging-x") },
			{ stagingPath: join(dir, "versions", ".staging-ok"), oldPath: join(dir, ".old-x") },
		]) {
			await expect(replaceDirectory(target, build, opts)).rejects.toThrow(TypeError);
		}
		expect(built).toBe(false);
		expect(await readdir(dir)).toEqual(["versions"]);
		expect(await readdir(join(dir, "versions"))).toEqual(["1.2.0"]);
		expect(await readdir(target)).toEqual(["old.txt"]);
	});

	it("名字撞上目标本身或彼此 → 抛 TypeError(暂存 = 目标会把原目录连根删掉)", async () => {
		const versions = join(dir, "versions");
		const target = join(versions, "1.2.0");
		await seedOld(target);
		const build = async () => {};
		for (const opts of [
			{ stagingPath: target },
			{ oldPath: target },
			{ stagingPath: join(versions, ".same"), oldPath: join(versions, ".same") },
		]) {
			await expect(replaceDirectory(target, build, opts)).rejects.toThrow(TypeError);
		}
		expect(await readdir(target)).toEqual(["old.txt"]);
		expect(await readdir(versions)).toEqual(["1.2.0"]);
	});
});
