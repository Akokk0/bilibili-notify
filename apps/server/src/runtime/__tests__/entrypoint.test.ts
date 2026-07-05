import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { isEntrypoint } from "../entrypoint.js";

/**
 * isEntrypoint 契约:`node <entry>` 直接启动时判真,被 import 时判假。
 * 关键边界:node 的 ESM loader 以 **realpath** 后的 URL 记 import.meta.url,而
 * argv[1] 保留用户敲的 symlink 路径(macOS /var→/private/var、~/bin 软链等)。
 * 只比字符串会静默判假 —— 进程什么都不干、退出码 0,是最难排查的一类失败。
 */
describe("isEntrypoint", () => {
	let dir: string;

	beforeEach(() => {
		// realpathSync:tmpdir 本身在 macOS 是 symlink,测试基准目录先归一到真实路径,
		// 让「symlink 用例」里的 symlink 是唯一变量。
		dir = mkdtempSync(join(realpathSync(tmpdir()), "bn-entry-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("entry 与模块路径一致 → true", () => {
		const entry = join(dir, "index.mjs");
		writeFileSync(entry, "");
		expect(isEntrypoint(pathToFileURL(entry).href, entry)).toBe(true);
	});

	it("entry 缺失(REPL / eval)→ false", () => {
		expect(isEntrypoint(pathToFileURL(join(dir, "index.mjs")).href, undefined)).toBe(false);
	});

	it("entry 指向别的文件 → false", () => {
		const entry = join(dir, "other.mjs");
		writeFileSync(entry, "");
		expect(isEntrypoint(pathToFileURL(join(dir, "index.mjs")).href, entry)).toBe(false);
	});

	it("entry 经 symlink 目录、metaUrl 是 realpath → true(node ESM 主入口语义)", () => {
		mkdirSync(join(dir, "real"));
		writeFileSync(join(dir, "real", "index.mjs"), "");
		symlinkSync(join(dir, "real"), join(dir, "link"));
		const entryViaSymlink = join(dir, "link", "index.mjs");
		const metaUrlRealpath = pathToFileURL(join(dir, "real", "index.mjs")).href;
		expect(isEntrypoint(metaUrlRealpath, entryViaSymlink)).toBe(true);
	});

	it("entry 不存在于磁盘 → false(realpath 失败不炸)", () => {
		expect(isEntrypoint(pathToFileURL(join(dir, "index.mjs")).href, join(dir, "missing.mjs"))).toBe(
			false,
		);
	});
});
