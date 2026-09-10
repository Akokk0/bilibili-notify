/**
 * 从面板传一个 zip 上来装拓展。
 *
 * 🔴 这条路把「往 `<dataDir>/extensions/` 里放东西」从**文件系统权限**降到了**一次面板
 * 会话**,而放进去的东西是**会被 import 的代码**。所以拆包这一层是一道真闸,不是格式转换:
 * 白名单收文件(只认清单 + 入口)、目录名只来自清单里那个已经过正则的 id、大小与层数都封顶。
 *
 * 另一条硬规矩:**软链不许覆盖** —— 那是 devtools 链进来的工作树,往里写等于写进 git 仓库。
 */

import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_API_VERSION } from "@bilibili-notify/internal";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { installExtensionPackage, openExtensionPackage } from "../install.js";

let root: string;

function manifest(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		id: "bridge",
		name: "机器人框架桥接",
		description: "测试用",
		version: "1.0.0",
		apiVersion: EXTENSION_API_VERSION,
		provides: ["push"],
		...over,
	});
}

/** 打一个包。`prefix` 模拟「把目录整个拖进压缩软件」那种多一层的 zip。 */
function pack(files: Record<string, string>, prefix = ""): Uint8Array {
	const entries: Record<string, Uint8Array> = {};
	for (const [name, text] of Object.entries(files)) entries[prefix + name] = strToU8(text);
	return zipSync(entries);
}

const GOOD = { "extension.json": manifest(), "index.mjs": "export function activate() {}" };

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "bn-ext-install-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("拆包", () => {
	it("清单 + 入口 —— 读出来的身份以**清单**为准", () => {
		const opened = openExtensionPackage(pack(GOOD));
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(opened.pkg.id).toBe("bridge");
		expect(opened.pkg.manifest.version).toBe("1.0.0");
	});

	/** 人会把目录整个拖进压缩软件 —— 多出来的那一层是常态,不是错误。 */
	it("多一层顶层目录也认,剥掉就是", () => {
		const opened = openExtensionPackage(pack(GOOD, "bridge/"));
		expect(opened.ok).toBe(true);
	});

	it("两层以上 → 不认:拓展包是清单 + 一个自包含入口,没有子目录", () => {
		const opened = openExtensionPackage(pack(GOOD, "a/b/"));
		expect(opened.ok).toBe(false);
	});

	/**
	 * 🔴 白名单,不是黑名单。放进去的每一个文件都会落到装载目录里,而那个目录里的
	 * `index.mjs` 是**要被 import 的**。多一个 `.mjs` 就是多一条我们没看过的代码路径。
	 */
	it("夹带别的文件 → 整包拒绝,并说清是哪一个", () => {
		const opened = openExtensionPackage(pack({ ...GOOD, "sneaky.mjs": "//" }));
		expect(opened.ok).toBe(false);
		if (opened.ok) return;
		expect(opened.errors.join()).toContain("sneaky.mjs");
	});

	it("缺入口 / 缺清单 → 各说各的", () => {
		const noCode = openExtensionPackage(pack({ "extension.json": manifest() }));
		expect(noCode.ok).toBe(false);
		if (!noCode.ok) expect(noCode.errors.join()).toContain("index.mjs");
		const noManifest = openExtensionPackage(pack({ "index.mjs": "//" }));
		expect(noManifest.ok).toBe(false);
		if (!noManifest.ok) expect(noManifest.errors.join()).toContain("extension.json");
	});

	it("清单不合法 → 把哪一格不合法说出来", () => {
		const opened = openExtensionPackage(pack({ ...GOOD, "extension.json": manifest({ id: "" }) }));
		expect(opened.ok).toBe(false);
		if (!opened.ok) expect(opened.errors.join()).toContain("id");
	});

	/** 装一个跑不起来的东西没有意义,而**这一刻**的错误信息是最清楚的一次。 */
	it("给别的宿主版本写的 → 当场拒绝,别等装进去再在页面上显示 incompatible", () => {
		const opened = openExtensionPackage(
			pack({ ...GOOD, "extension.json": manifest({ apiVersion: EXTENSION_API_VERSION + 1 }) }),
		);
		expect(opened.ok).toBe(false);
		if (!opened.ok) expect(opened.errors.join()).toMatch(/契约|版本/);
	});

	/** 🔴 zip 里的路径是攻击者写的,`..` 一律不认 —— 落盘那一步不该再自己防一遍。 */
	it("路径里带 .. → 拒绝", () => {
		expect(openExtensionPackage(pack({ ...GOOD, "../evil.mjs": "//" })).ok).toBe(false);
		expect(openExtensionPackage(pack(GOOD, "../")).ok).toBe(false);
	});

	it("入口太大 → 拒绝(自包含 bundle 也就几百 KB)", () => {
		const huge = "x".repeat(9 * 1024 * 1024);
		const opened = openExtensionPackage(pack({ ...GOOD, "index.mjs": huge }));
		expect(opened.ok).toBe(false);
		if (!opened.ok) expect(opened.errors.join()).toContain("过大");
	});

	it("压根不是 zip → 一句人话,别把 fflate 的异常摊出去", () => {
		const opened = openExtensionPackage(strToU8("这不是 zip"));
		expect(opened.ok).toBe(false);
		if (!opened.ok) expect(opened.errors.join()).toContain("zip");
	});
});

describe("落盘", () => {
	async function open(): Promise<Extract<ReturnType<typeof openExtensionPackage>, { ok: true }>> {
		const opened = openExtensionPackage(pack(GOOD));
		if (!opened.ok) throw new Error(opened.errors.join());
		return opened;
	}

	it("新装 → 目录长在装载根里,两个文件都在", async () => {
		const { pkg } = await open();
		const out = await installExtensionPackage({ root, pkg });
		expect(out.replaced).toBe(false);
		expect(await readFile(join(root, "bridge", "index.mjs"), "utf8")).toContain("activate");
		expect(JSON.parse(await readFile(join(root, "bridge", "extension.json"), "utf8")).id).toBe(
			"bridge",
		);
	});

	/**
	 * 🔴 覆盖 = 换掉**已经加载过**的代码,而 ESM 在这个进程里换不掉(决策 10)。所以这一步
	 * 要如实说「得重启」—— 说成「装好了」的话,主人会以为新版本已经在跑。
	 */
	it("盖掉一份已经装着的 → 说清楚这是覆盖,旧文件不残留", async () => {
		await mkdir(join(root, "bridge"), { recursive: true });
		await writeFile(join(root, "bridge", "extension.json"), manifest({ version: "0.9.0" }));
		await writeFile(join(root, "bridge", "index.mjs"), "// 旧的");
		await writeFile(join(root, "bridge", "leftover.txt"), "上一版留下的");

		const { pkg } = await open();
		const out = await installExtensionPackage({ root, pkg });

		expect(out.replaced).toBe(true);
		expect(await readFile(join(root, "bridge", "index.mjs"), "utf8")).toContain("activate");
		await expect(readFile(join(root, "bridge", "leftover.txt"), "utf8")).rejects.toThrow();
	});

	/** 🔴 那是 devtools 链进来的**仓库工作树**。往里写 = 往 git status 里拉屎。 */
	it("目标是条软链 → 拒绝,一个字节都不写", async () => {
		const elsewhere = join(root, "..", `bn-ext-src-${Date.now()}`);
		await mkdir(elsewhere, { recursive: true });
		await symlink(elsewhere, join(root, "bridge"), "dir");
		const { pkg } = await open();

		await expect(installExtensionPackage({ root, pkg })).rejects.toThrow(/软链/);
		expect(await readlink(join(root, "bridge"))).toBe(elsewhere);
		await rm(elsewhere, { recursive: true, force: true });
	});

	it("装完不留临时目录 —— 装载器会把它当成一个拓展扫出来", async () => {
		const { pkg } = await open();
		await installExtensionPackage({ root, pkg });
		const { readdir } = await import("node:fs/promises");
		expect(await readdir(root)).toEqual(["bridge"]);
	});

	it("装载根还不存在时自己建 —— 头一次装本来就没有它", async () => {
		const fresh = join(root, "nested", "extensions");
		const { pkg } = await open();
		await installExtensionPackage({ root: fresh, pkg });
		expect((await lstat(join(fresh, "bridge"))).isDirectory()).toBe(true);
	});
});
