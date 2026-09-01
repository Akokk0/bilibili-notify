import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { pruneOldVersions } from "../prune-versions.js";

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
		// 一个叫 `2026-09-01` 的手动备份、一份 `my-notes`、装到一半留下的 `.staging-*`,
		// 都不是我们的东西。清理策略越是「顺手」,越容易把别人的数据顺手清掉。
		const root = versionsWith("0.9.0");
		mkdirSync(join(root, "2026-09-01"), { recursive: true });
		mkdirSync(join(root, "my-notes"), { recursive: true });
		mkdirSync(join(root, ".staging-0.9.0-abc"), { recursive: true });
		writeFileSync(join(root, "boot-state.json"), "{}");

		pruneOldVersions({ versionsRoot: root, keep: ["0.9.0"] });

		expect(existsSync(join(root, "2026-09-01"))).toBe(true);
		expect(existsSync(join(root, "my-notes"))).toBe(true);
		expect(existsSync(join(root, ".staging-0.9.0-abc"))).toBe(true);
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
});
