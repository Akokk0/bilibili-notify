/**
 * 从面板传一个 zip 上来装拓展。
 *
 * 🔴 这条路把「往 `<数据根>/extensions/` 里放东西」从**文件系统权限**降到了**一次面板
 * 会话**,而放进去的东西是**会被 import 的代码**。所以拆包这一层是一道真闸,不是格式转换:
 * 白名单收文件(只认清单 + 入口)、目录名只来自清单里那个已经过正则的 id、大小与层数都封顶。
 *
 * 另一条硬规矩:**软链不许覆盖** —— 那是 devtools 链进来的工作树,往里写等于写进 git 仓库。
 */

import { readdirSync } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_API_RANGE } from "@bilibili-notify/internal";
import { strFromU8, strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ExtensionConflictError } from "../conflict-error.js";
import { EXTENSION_DOC_MAX_BYTES } from "../discover.js";
import { installExtensionPackage, openExtensionPackage } from "../install.js";

let root: string;

function manifest(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		id: "bridge",
		name: "机器人框架桥接",
		description: "测试用",
		version: "1.0.0",
		apiVersion: 1,
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

/**
 * 把 zip 里某个条目**声明**的解压大小改成 `size`(本地头 + 中央目录两处),压缩数据不动 ——
 * 模拟一个撒谎的包。zip 结构里的偏移是定死的:本地头签名后 22 字节、中央目录签名后 24 字节。
 */
function forgeUncompressedSize(zip: Uint8Array, name: string, size: number): Uint8Array {
	const out = new Uint8Array(zip);
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
	const nameBytes = strToU8(name);
	const matches = (at: number) => {
		for (let i = 0; i < nameBytes.length; i += 1) if (out[at + i] !== nameBytes[i]) return false;
		return true;
	};
	for (let i = 0; i + 4 <= out.length; i += 1) {
		const sig = view.getUint32(i, true);
		if (
			sig === 0x04034b50 &&
			view.getUint16(i + 26, true) === nameBytes.length &&
			matches(i + 30)
		) {
			view.setUint32(i + 22, size, true);
		}
		if (
			sig === 0x02014b50 &&
			view.getUint16(i + 28, true) === nameBytes.length &&
			matches(i + 46)
		) {
			view.setUint32(i + 24, size, true);
		}
	}
	return out;
}

/** 失败的全部话:一句概括,加上逐条(检查意见多于一条时分在 `issues` 里)。 */
function textOf(failure: { message: string; issues?: { message: string }[] }): string {
	return [failure.message, ...(failure.issues ?? []).map((issue) => issue.message)].join("\n");
}

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
		// 只有一句检查意见:话就是 message,不再另摆一份 issues。
		expect(opened.code).toBe("invalid");
		expect(opened.message).toContain("sneaky.mjs");
		expect(opened.issues).toBeUndefined();
	});

	/** 意见不止一条:message 一句概括,逐条放 issues —— 面板把它们摆成清单,主人照着一处处改。 */
	it("夹带了不止一个文件 → message 一句概括,每个文件一条 issues", () => {
		const opened = openExtensionPackage(pack({ ...GOOD, "a.mjs": "//", "b.mjs": "//" }));
		expect(opened.ok).toBe(false);
		if (opened.ok) return;
		expect(opened.code).toBe("invalid");
		expect(opened.message).toBe("这个拓展包没通过检查（共 2 条）");
		expect(opened.issues).toHaveLength(2);
		expect(opened.issues?.map((issue) => issue.message).join("\n")).toMatch(/a\.mjs[\s\S]*b\.mjs/);
	});

	/**
	 * 🔴 文档进白名单、`sneaky.mjs` 照旧拒 —— 两条并存才是这道闸的意思:放行的判据不是
	 * 「看着无害」,而是**它会不会被 import**。README / CHANGELOG 是给人看的,落进装载目录
	 * 也没有任何一条代码路径会碰它们;而多一个 `.mjs` 就是多一条我们没看过的代码路径。
	 *
	 * 装完能在面板里读到它俩,靠的就是这两份跟着包进装载目录 —— 拿不到就只能去仓库翻,
	 * 而第三方拓展的仓库在哪、还在不在,我们都不知道。
	 */
	it("带 README.md / CHANGELOG.md → 收下,两份原样交出来", () => {
		const opened = openExtensionPackage(
			pack({
				...GOOD,
				"README.md": "# 桥接\n\n借 koishi 的 bot。",
				"CHANGELOG.md": "## [0.0.1]",
			}),
		);
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(strFromU8(opened.pkg.docs.readme as Uint8Array)).toContain("借 koishi 的 bot");
		expect(strFromU8(opened.pkg.docs.changelog as Uint8Array)).toContain("[0.0.1]");
	});

	/**
	 * 🔴 **文档超上限不该把整个拓展挡在门外。** 它是一份纯装饰、没有任何代码路径会碰的
	 * 文件 —— 因为它太大就让一个功能完好的拓展装不上,代价完全不对等,而且错误还会包成
	 * 「包拆不开」。丢掉那一份、照常装,与读回那头(`docs.ts` 把「读不到 / 不是文件 /
	 * 超上限」一律当「没有」)是同一个路子,两端对得上。
	 *
	 * 发布链上走不到这里 —— `scripts/pack-extension.mjs` 在打包那一步就拒了。
	 */
	it("文档超上限 → 丢掉那一份,拓展照样装得上", () => {
		const opened = openExtensionPackage(
			pack({ ...GOOD, "README.md": "x".repeat(EXTENSION_DOC_MAX_BYTES + 1) }),
		);
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(opened.pkg.docs.readme).toBeUndefined();
		// 另一份没超,照样收 —— 别因为一份坏了就把两份都扔了。
		expect(opened.pkg.manifest.id).toBe("bridge");
	});

	it("缺入口 / 缺清单 → 各说各的", () => {
		const noCode = openExtensionPackage(pack({ "extension.json": manifest() }));
		expect(noCode.ok).toBe(false);
		if (!noCode.ok) {
			expect(noCode.code).toBe("invalid");
			expect(textOf(noCode)).toContain("index.mjs");
		}
		const noManifest = openExtensionPackage(pack({ "index.mjs": "//" }));
		expect(noManifest.ok).toBe(false);
		if (!noManifest.ok) expect(textOf(noManifest)).toContain("extension.json");
	});

	it("清单不合法 → 把哪一格不合法说出来", () => {
		const opened = openExtensionPackage(pack({ ...GOOD, "extension.json": manifest({ id: "" }) }));
		expect(opened.ok).toBe(false);
		if (!opened.ok) {
			expect(opened.code).toBe("invalid");
			expect(textOf(opened)).toContain("id");
		}
	});

	/** 装一个跑不起来的东西没有意义,而**这一刻**的错误信息是最清楚的一次。 */
	it("给更新的宿主写的 → 当场拒绝,别等装进去再在页面上显示 incompatible", () => {
		const opened = openExtensionPackage(
			pack({
				...GOOD,
				"extension.json": manifest({ apiVersion: EXTENSION_API_RANGE.current + 1 }),
			}),
		);
		expect(opened.ok).toBe(false);
		if (!opened.ok) {
			// 版本对不上是「这个宿主不认」,不是包的内容写错了。
			expect(opened.code).toBe("unsupported");
			expect(opened.message).toContain("先升级 BN");
		}
	});

	/**
	 * 将来的清单格式我们不认识 —— 主人拿着这个包,该听到的是「版本不合、先升级 BN」,而不是
	 * 一串「contributes.chat: 不认识的键」(ADR-0019 决策 18)。
	 */
	it("将来的格式我们不认识 → 说版本不合,不去挑格式的毛病", () => {
		const opened = openExtensionPackage(
			pack({
				...GOOD,
				"extension.json": manifest({
					apiVersion: EXTENSION_API_RANGE.current + 1,
					provides: undefined,
					contributes: { chat: {} },
				}),
			}),
		);
		expect(opened.ok).toBe(false);
		if (opened.ok) return;
		expect(opened.code).toBe("unsupported");
		expect(opened.issues).toBeUndefined();
		expect(opened.message).toContain("先升级 BN");
	});

	it("v2 清单的包 → 收下", () => {
		const opened = openExtensionPackage(
			pack({
				...GOOD,
				"extension.json": manifest({
					apiVersion: 2,
					provides: undefined,
					contributes: {
						push: { display: { label: "桥", shortLabel: "桥", color: "#a855f7" } },
					},
				}),
			}),
		);
		expect(opened.ok).toBe(true);
		if (opened.ok) expect(opened.pkg.manifest.apiVersion).toBe(2);
	});

	/** 档位对、要的契约小号比这台 BN 的高(ADR-0019 决策 59):装的时候就拦住,说清要几号。 */
	it("要更高契约小号的 v2 包 → 当场拒绝,说要几号、BN 是几号、先升级 BN", () => {
		const wants = EXTENSION_API_RANGE.revision + 1;
		const opened = openExtensionPackage(
			pack({
				...GOOD,
				"extension.json": manifest({
					apiVersion: 2,
					apiRevision: wants,
					provides: undefined,
					contributes: {
						push: { display: { label: "桥", shortLabel: "桥", color: "#a855f7" } },
					},
				}),
			}),
		);
		expect(opened.ok).toBe(false);
		if (opened.ok) return;
		expect(opened.code).toBe("unsupported");
		expect(opened.issues).toBeUndefined();
		expect(opened.message).toContain(`小号 ${wants}`);
		expect(opened.message).toContain(`只到小号 ${EXTENSION_API_RANGE.revision}`);
		expect(opened.message).toContain("先升级 BN");
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
		if (!opened.ok) expect(textOf(opened)).toContain("过大");
	});

	/**
	 * 🔴 压缩炸弹:zip 头里**声明**的解压大小是解压前就能读到的,而 fflate 按它先分配内存。
	 * 上限要在解压**之前**拦,否则一个 300KB 的包能解出 300MB —— 镜像的堆只有 512MB。
	 */
	it("zip 头声明的解压大小超上限 → 解压前就拒,说的是「过大」而不是「不是 zip」", () => {
		const forged = forgeUncompressedSize(pack(GOOD), "index.mjs", 2 ** 31);
		const opened = openExtensionPackage(forged);
		expect(opened.ok).toBe(false);
		if (!opened.ok) {
			expect(opened.code).toBe("invalid");
			expect(textOf(opened)).toContain("过大");
			expect(textOf(opened)).not.toContain("zip");
		}
	});

	/**
	 * 🔴 单文件那道闸拦不住「**很多个**各自合规的条目」:白名单是解压**之后**才对的,到那
	 * 会儿几十个 7MB 的条目早已经解进内存了(镜像的堆只有 512MB)。总量得在同一道 filter 里
	 * 拦,而且那句话要说清是**总量** —— 报「某某过大」会让主人去一个个文件里找那个大的。
	 */
	it("每个条目都不超单文件上限、加起来却几百 MB → 按**总量**拦下", () => {
		const files: Record<string, string> = { ...GOOD };
		for (let i = 0; i < 8; i += 1) files[`chunk${i}.mjs`] = "//";
		let zip = pack(files);
		for (let i = 0; i < 8; i += 1) {
			zip = forgeUncompressedSize(zip, `chunk${i}.mjs`, 7 * 1024 * 1024);
		}
		const opened = openExtensionPackage(zip);
		expect(opened.ok).toBe(false);
		if (!opened.ok) expect(textOf(opened)).toContain("总量");
	});

	it("压根不是 zip → 一句人话,别把 fflate 的异常摊出去", () => {
		const opened = openExtensionPackage(strToU8("这不是 zip"));
		expect(opened.ok).toBe(false);
		if (!opened.ok) {
			expect(opened.code).toBe("invalid");
			expect(textOf(opened)).toContain("zip");
		}
	});
});

describe("落盘", () => {
	async function open(): Promise<Extract<ReturnType<typeof openExtensionPackage>, { ok: true }>> {
		const opened = openExtensionPackage(pack(GOOD));
		if (!opened.ok) throw new Error(textOf(opened));
		return opened;
	}

	async function openWithDocs(): Promise<
		Extract<ReturnType<typeof openExtensionPackage>, { ok: true }>
	> {
		const opened = openExtensionPackage(
			pack({ ...GOOD, "README.md": "# 桥接", "CHANGELOG.md": "## [1.0.0]" }),
		);
		if (!opened.ok) throw new Error(textOf(opened));
		return opened;
	}

	/**
	 * 文档得**跟着包落盘** —— 面板读的是装载目录里那一份。不落盘的话装完就没了,
	 * 而第三方拓展的仓库在哪、还在不在,我们一概不知,没有第二个地方能补。
	 */
	it("包里带文档 → 两份跟着落进装载目录", async () => {
		const { pkg } = await openWithDocs();
		await installExtensionPackage({ root, pkg });
		expect(await readFile(join(root, "bridge", "README.md"), "utf8")).toContain("桥接");
		expect(await readFile(join(root, "bridge", "CHANGELOG.md"), "utf8")).toContain("[1.0.0]");
	});

	/** 没写文档不是装不了的理由,更不该在目录里留两个空文件。 */
	it("包里没带文档 → 目录里就没有这两个文件", async () => {
		const { pkg } = await open();
		await installExtensionPackage({ root, pkg });
		// 两个都要断 —— 只断 README 的话,把 CHANGELOG 改成无条件写空文件这条照样绿。
		await expect(readFile(join(root, "bridge", "README.md"), "utf8")).rejects.toThrow();
		await expect(readFile(join(root, "bridge", "CHANGELOG.md"), "utf8")).rejects.toThrow();
	});

	it("新装 → 目录长在装载根里,不多不少就这两个文件", async () => {
		// 装之前盘上没有它 —— 这是新装,不是覆盖。
		await expect(lstat(join(root, "bridge"))).rejects.toThrow();
		const { pkg } = await open();
		await installExtensionPackage({ root, pkg });
		expect((await readdir(join(root, "bridge"))).sort()).toEqual(["extension.json", "index.mjs"]);
		expect(await readFile(join(root, "bridge", "index.mjs"), "utf8")).toContain("activate");
		expect(JSON.parse(await readFile(join(root, "bridge", "extension.json"), "utf8")).id).toBe(
			"bridge",
		);
	});

	/**
	 * 覆盖是**整份换掉**:旧目录先删再落新的 —— 留着上一版的残余文件,下一次谁也说不清跑的是
	 * 哪一份。换不换得上(要不要重启)不归这一层,装载器按入口指纹判(ADR-0012 决策 47)。
	 */
	it("盖掉一份已经装着的 → 整份换成新的,旧文件不残留", async () => {
		await mkdir(join(root, "bridge"), { recursive: true });
		await writeFile(join(root, "bridge", "extension.json"), manifest({ version: "0.9.0" }));
		await writeFile(join(root, "bridge", "index.mjs"), "// 旧的");
		await writeFile(join(root, "bridge", "leftover.txt"), "上一版留下的");

		const { pkg } = await open();
		await installExtensionPackage({ root, pkg });

		expect((await readdir(join(root, "bridge"))).sort()).toEqual(["extension.json", "index.mjs"]);
		expect(await readFile(join(root, "bridge", "index.mjs"), "utf8")).toContain("activate");
		expect(JSON.parse(await readFile(join(root, "bridge", "extension.json"), "utf8")).version).toBe(
			"1.0.0",
		);
	});

	/** 🔴 那是 devtools 链进来的**仓库工作树**。往里写 = 往 git status 里拉屎。 */
	it("目标是条软链 → 拒绝,一个字节都不写", async () => {
		const elsewhere = join(root, "..", `bn-ext-src-${Date.now()}`);
		await mkdir(elsewhere, { recursive: true });
		await symlink(elsewhere, join(root, "bridge"), "dir");
		const { pkg } = await open();

		// 这是可预期的拒绝,自带 conflict 码 —— 路由只接这一种,别的抛错(磁盘写失败)不是它。
		const refused = await installExtensionPackage({ root, pkg }).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(refused).toBeInstanceOf(ExtensionConflictError);
		expect((refused as ExtensionConflictError).code).toBe("conflict");
		expect((refused as ExtensionConflictError).message).toMatch(/软链/);
		expect(await readlink(join(root, "bridge"))).toBe(elsewhere);
		await rm(elsewhere, { recursive: true, force: true });
	});

	it("装完不留临时目录 —— 装载器会把它当成一个拓展扫出来", async () => {
		const { pkg } = await open();
		await installExtensionPackage({ root, pkg });
		expect(await readdir(root)).toEqual(["bridge"]);
	});

	/**
	 * 🔴 两个标签页同时点「装」:路由层没有锁。各自 mkdtemp → 各自 rm → 各自 rename,交错起来
	 * 第二个 rename 撞上第一个刚落好的目录(ENOTEMPTY),或者把它删掉。同 id 的安装必须排队。
	 */
	it("同一个 id 并发装两次 → 排队,两次都成,盘上只剩最后落的那一份", async () => {
		// 头一份多带一份 README:第二份落下之后它必须不见了 —— 证明第二次是等第一次落完、再把它
		// 整份换掉的,而不是两边交错着各写一半。
		const a = openExtensionPackage(pack({ ...GOOD, "README.md": "# 第一份" }));
		const b = openExtensionPackage(
			pack({ ...GOOD, "extension.json": manifest({ version: "1.0.1" }) }),
		);
		if (!a.ok || !b.ok) throw new Error("fixture");
		await expect(lstat(join(root, "bridge"))).rejects.toThrow();
		await Promise.all([
			installExtensionPackage({ root, pkg: a.pkg }),
			installExtensionPackage({ root, pkg: b.pkg }),
		]);
		expect(await readdir(root)).toEqual(["bridge"]);
		expect((await readdir(join(root, "bridge"))).sort()).toEqual(["extension.json", "index.mjs"]);
		expect(JSON.parse(await readFile(join(root, "bridge", "extension.json"), "utf8")).version).toBe(
			"1.0.1",
		);
	});

	/**
	 * 「一个字节都不留」:落到一半失败(这里是入口写不进去,清单那时已经写进暂存了)—— 新装的话目标
	 * 名字根本不会出现;盖已经装着的话旧的原样还在;两种情况下装载根里都不剩暂存目录。目标名字只经
	 * 最后那一下改名出现,所以从来看不到「清单是新的、代码是旧的」的半成品。
	 */
	it("落到一半失败 → 新装不冒出目录,盖旧的时旧的原样还在,都不留暂存", async () => {
		const { pkg } = await open();
		const broken = { ...pkg, entry: 123 as unknown as Uint8Array };

		await expect(installExtensionPackage({ root, pkg: broken })).rejects.toBeDefined();
		expect(await readdir(root)).toEqual([]);

		await installExtensionPackage({ root, pkg });
		const installed = await readFile(join(root, "bridge", "index.mjs"), "utf8");
		await expect(
			installExtensionPackage({
				root,
				pkg: { ...broken, manifestBytes: strToU8(manifest({ version: "9.9.9" })) },
			}),
		).rejects.toBeDefined();
		expect(await readdir(root)).toEqual(["bridge"]);
		expect(await readFile(join(root, "bridge", "index.mjs"), "utf8")).toBe(installed);
		expect(JSON.parse(await readFile(join(root, "bridge", "extension.json"), "utf8")).version).toBe(
			"1.0.0",
		);
	});

	/**
	 * 🔴 暂存目录就建在装载根里,而装载器扫根时**只按「点开头」跳过**(`discover.ts`)—— 名字不带点,
	 * 进程在改名之前被杀,它就带着一份合法清单留在盘上,变成每次开机多出来的一张删不掉的 unreadable 卡。
	 * 所以落盘过程中装载根里出现的东西,除了将要装成的那个目录,名字都得点开头。
	 */
	it("落盘过程中,装载根里的暂存目录是点开头的 —— 装载器不会把它当拓展扫出来", async () => {
		const { pkg } = await open();
		let during: string[] | undefined;
		// 入口是清单之后才读的:读到它时暂存目录已经建好、里面有清单了。
		const spying = {
			...pkg,
			get entry() {
				during = readdirSync(root);
				return pkg.entry;
			},
		};
		await installExtensionPackage({ root, pkg: spying });
		expect(during).toBeDefined();
		expect(during?.length).toBe(1);
		expect(during?.every((name) => name.startsWith("."))).toBe(true);
	});

	it("装载根还不存在时自己建 —— 头一次装本来就没有它", async () => {
		const fresh = join(root, "nested", "extensions");
		const { pkg } = await open();
		await installExtensionPackage({ root: fresh, pkg });
		expect((await lstat(join(fresh, "bridge"))).isDirectory()).toBe(true);
	});
});
