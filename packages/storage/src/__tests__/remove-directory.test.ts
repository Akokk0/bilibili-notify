import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { tempPathFor } from "../atomic-file";
import { removeDirectory } from "../remove-directory";
import { sweepTempFiles } from "../sweep";

/**
 * 持久化底层:删目录。原地 `rm -rf` 删到一半被杀会留下半个目录,开机扫描会把它当成一套坏皮肤;
 * 所以先改名(目标名字瞬间消失)再删,删到一半的残骸带 `.bn-tmp.` 标记,由开机清扫收掉。
 */

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-remove-dir-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function seed(target: string) {
	await mkdir(join(target, "assets"), { recursive: true });
	await writeFile(join(target, "manifest.json"), "{}");
	await writeFile(join(target, "assets", "a.png"), "x");
}

describe("removeDirectory", () => {
	it("目标在 → 整个删掉回 true;目标与改名后的临时目录都不在,邻居不动", async () => {
		const skins = join(dir, "skins");
		await seed(join(skins, "s1"));
		await seed(join(skins, "s2"));
		expect(await removeDirectory(join(skins, "s1"))).toBe(true);
		expect(await readdir(skins)).toEqual(["s2"]);
		expect(await readFile(join(skins, "s2", "manifest.json"), "utf8")).toBe("{}");
	});

	it("目标不在 → 回 false,什么都不建", async () => {
		await mkdir(join(dir, "skins"));
		expect(await removeDirectory(join(dir, "skins", "nope"))).toBe(false);
		expect(await readdir(join(dir, "skins"))).toEqual([]);
	});

	it("目标的父目录都不在 → 也是回 false", async () => {
		expect(await removeDirectory(join(dir, "no-such-parent", "s1"))).toBe(false);
	});

	// 「先改名」这一步没有别的办法从外面看见:让 rm 在改名之后必失败(子目录去掉写权限,
	// 里面的文件删不掉),看目标名字是不是照样已经没了。root 不受权限位约束,Windows 没有这套权限位。
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"删到一半失败:目标名字已经没了,残骸带 .bn-tmp. 标记,开机清扫收得掉",
		async () => {
			const skins = join(dir, "skins");
			const target = join(skins, "s1");
			await seed(target);
			await seed(join(skins, "s2"));
			await chmod(join(target, "assets"), 0o500);

			await expect(removeDirectory(target)).rejects.toThrow();

			const names = await readdir(skins);
			const leftoverName = names.find((n) => n.startsWith("s1."));
			// 先把权限还回去:后面哪条断言失败,afterEach 的清理和清扫都得删得动
			if (leftoverName) await chmod(join(skins, leftoverName, "assets"), 0o700);
			await chmod(join(target, "assets"), 0o700).catch(() => {}); // 原地删的话,残骸就在原名下

			expect(names).toHaveLength(2);
			expect(names).toContain("s2");
			expect(leftoverName).toMatch(/^s1\.bn-tmp\.\d+\.[0-9a-f]+$/); // s1 这个名字已经不在
			const leftover = join(skins, leftoverName as string);

			const report = await sweepTempFiles(dir);
			expect(report.removed).toEqual([leftover]);
			expect(await readdir(skins)).toEqual(["s2"]);
		},
	);

	it("被杀在 rm 中途留下的残骸(带 .bn-tmp. 标记的半个目录)→ sweepTempFiles 收掉,别的不碰", async () => {
		const skins = join(dir, "skins");
		await seed(join(skins, "s2"));
		const leftover = tempPathFor(join(skins, "s1"));
		await mkdir(join(leftover, "assets"), { recursive: true });
		await writeFile(join(leftover, "manifest.json"), "{}");
		const report = await sweepTempFiles(dir);
		expect(report.removed).toEqual([leftover]);
		expect(await readdir(skins)).toEqual(["s2"]);
	});
});
