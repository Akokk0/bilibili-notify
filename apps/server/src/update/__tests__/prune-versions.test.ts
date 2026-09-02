import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { pruneOldVersions, removeVersionDir } from "../prune-versions.js";

/**
 * 版本目录的保留策略:**只留当前 + 上一版**。
 *
 * 一份载荷 ~25MB,不清的话装十次就是 250MB —— 而这套东西的目标用户里有相当一批
 * 跑在小机器 / NAS 上,`/data` 常常是最不该被这么用的那块盘。
 */

const created: string[] = [];

afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function versionsWith(...names: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "bn-prune-"));
	created.push(root);
	for (const name of names) {
		mkdirSync(join(root, name), { recursive: true });
		writeFileSync(join(root, name, "index.mjs"), "// x\n");
	}
	return root;
}

describe("pruneOldVersions", () => {
	it("留下点名要的,删掉其余的版本目录", () => {
		const root = versionsWith("0.8.0", "0.9.0", "0.10.0");

		const removed = pruneOldVersions({ versionsRoot: root, keep: ["0.10.0", "0.9.0"] });

		expect(existsSync(join(root, "0.10.0"))).toBe(true);
		expect(existsSync(join(root, "0.9.0"))).toBe(true);
		expect(existsSync(join(root, "0.8.0"))).toBe(false);
		expect(removed).toEqual(["0.8.0"]);
	});

	it("不像版本号的目录一个都不碰 —— /data 是用户挂出来的,他真的会往里丢东西", () => {
		// 一个叫 `2026-09-01` 的手动备份、一份 `my-notes`、一个 `.git`,都不是我们的东西。
		// 清理策略越是「顺手」,越容易把别人的数据顺手清掉。(我们自己的 `.staging-*` /
		// `.old-*` 残留是另一回事,见下面那条。)
		const root = versionsWith("0.9.0");
		mkdirSync(join(root, "2026-09-01"), { recursive: true });
		mkdirSync(join(root, "my-notes"), { recursive: true });
		mkdirSync(join(root, ".git"), { recursive: true });
		writeFileSync(join(root, "boot-state.json"), "{}");

		pruneOldVersions({ versionsRoot: root, keep: ["0.9.0"] });

		expect(existsSync(join(root, "2026-09-01"))).toBe(true);
		expect(existsSync(join(root, "my-notes"))).toBe(true);
		expect(existsSync(join(root, ".git"))).toBe(true);
		expect(existsSync(join(root, "boot-state.json"))).toBe(true);
	});

	it("keep 里写了个根本不存在的版本 → 不当回事,照常清理", () => {
		const root = versionsWith("0.8.0", "0.9.0");

		pruneOldVersions({ versionsRoot: root, keep: ["0.9.0", "0.99.0"] });

		expect(existsSync(join(root, "0.9.0"))).toBe(true);
		expect(existsSync(join(root, "0.8.0"))).toBe(false);
	});

	it("目录不存在 / 删不动都不抛 —— 清理失败不该把一次成功的升级变成失败", () => {
		// 清理是省磁盘的,不是升级成功的条件。为它抛异常等于把「装好了但没打扫干净」
		// 报成「升级失败」,用户会去重试一次已经成功了的事。
		expect(() =>
			pruneOldVersions({ versionsRoot: "/definitely/not/here", keep: [] }),
		).not.toThrow();
	});

	it("keep 是空的也照删 —— 但那是调用方的决定,不是这里的默认", () => {
		const root = versionsWith("0.9.0");

		expect(pruneOldVersions({ versionsRoot: root, keep: [] })).toEqual(["0.9.0"]);
	});
	it("我们自己的残留(.staging-* / .old-*)会被扫掉;用户放的别的东西一个不碰", () => {
		// 解压到一半被 SIGKILL / 断电,`.staging-*` 就永远留在 /data/versions 里,一份 25MB;
		// 换版本时挪走的 `.old-*` 也一样。它们是我们自己的命名空间,不是用户的文件 ——
		// 「只碰版本号形状的目录」那条纪律是为了保护用户的东西,不是保护我们的垃圾。
		const versionsRoot = versionsWith(
			"0.9.0",
			".staging-0.10.0-deadbeef",
			".old-0.9.0-cafebabe",
			"2026-09-01-backup",
			".git",
		);

		pruneOldVersions({ versionsRoot, keep: ["0.9.0"] });

		expect(existsSync(join(versionsRoot, ".staging-0.10.0-deadbeef"))).toBe(false);
		expect(existsSync(join(versionsRoot, ".old-0.9.0-cafebabe"))).toBe(false);
		expect(existsSync(join(versionsRoot, "0.9.0"))).toBe(true);
		expect(existsSync(join(versionsRoot, "2026-09-01-backup"))).toBe(true);
		expect(existsSync(join(versionsRoot, ".git"))).toBe(true);
	});
});

describe("removeVersionDir", () => {
	// 撤回一个版本以前是反着调保留策略实现的(「除它以外全留」),于是撤回的行为会跟着
	// 保留策略一起变 —— 哪天策略改成留三份,撤回就悄悄开始留下被召回的构建。
	it("只删点名的那一个,别的版本目录一律不碰", () => {
		const root = versionsWith("0.8.0", "0.9.0", "0.10.0");

		expect(removeVersionDir(root, "0.9.0")).toBe(true);

		expect(existsSync(join(root, "0.9.0"))).toBe(false);
		expect(existsSync(join(root, "0.8.0"))).toBe(true);
		expect(existsSync(join(root, "0.10.0"))).toBe(true);
	});

	it("不长得像版本号的一律不删 —— 这个名字来自清单,不该能指到别处", () => {
		const root = versionsWith("0.9.0");
		mkdirSync(join(root, "notes"), { recursive: true });

		expect(removeVersionDir(root, "notes")).toBe(false);
		expect(removeVersionDir(root, "..")).toBe(false);

		expect(existsSync(join(root, "notes"))).toBe(true);
		expect(existsSync(root)).toBe(true);
	});
});
