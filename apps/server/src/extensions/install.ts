/**
 * 从一个 zip 装拓展 —— 面板上那条「传一个包上来」。
 *
 * 🔴 **这条路把「往装载目录里放代码」从文件系统权限降到了一次面板会话**,而放进去的东西
 * 是会被 `import` 的。所以拆包这一层是一道**真闸**,不是格式转换:
 * ① **白名单收文件** —— 只认清单、入口、文档与 `locales/<语言码>.json`,夹带的一律整包拒绝
 *    (黑名单永远漏);
 * ② **目录名只来自清单里那个 id**,而它已经过了 `ExtensionIdSchema` 的正则 —— zip 里的
 *    路径是打包的人写的,一个字都不拿来拼路径;
 * ③ 层数、大小、文件数都封顶。
 *
 * ⚠️ 装的时候**不验签**:签名分发那条链(ADR-0005 那套)还没建。所以第一版信的是「能登进
 * 这个面板的人」—— 与「主人自己把目录拷进 `<数据根>/extensions/`」同一档信任,只是省了
 * 一次 ssh。UI 上那句「只装信得过的包」不是客套。
 */

import { randomBytes } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	EXTENSION_API_RANGE,
	type ExtensionManifest,
	fail,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import { LOCALES, type Locale } from "@bilibili-notify/internal/i18n";
import { atomicWriteFile, replaceDirectory } from "@bilibili-notify/storage";
import { strFromU8, unzipSync } from "fflate";
import { t } from "../i18n/index.js";
import { failureOfChecks } from "../util/failure-text.js";
import { isJunkZipEntry } from "../zip-junk.js";
import { ExtensionConflictError } from "./conflict-error.js";
import {
	apiVersionMismatch,
	EXTENSION_CHANGELOG_FILE,
	EXTENSION_DOC_MAX_BYTES,
	EXTENSION_ENTRY_FILE,
	EXTENSION_MANIFEST_FILE,
	EXTENSION_README_FILE,
} from "./discover.js";
import { parseHostExtensionManifest } from "./identity.js";
import {
	EXTENSION_LOCALE_FILE_MAX_BYTES,
	EXTENSION_LOCALES_DIR,
	EXTENSION_LOCALES_TOTAL_MAX_BYTES,
} from "./locales.js";

/** 清单顶天几百字节,给到 512KB 是留给 icon 那段 SVG(它自己的上限是 64KB)。 */
const MAX_MANIFEST_BYTES = 512 * 1024;
/** 自包含 bundle:桥内联完第三方也就将近 300KB。8MB 已经宽得离谱,再大多半是打错了。 */
const MAX_CODE_BYTES = 8 * 1024 * 1024;
/** 进这道门的整包上限(路由那道闸用它),留足给未来的多文件包。 */
export const MAX_EXTENSION_PACKAGE_BYTES = 10 * 1024 * 1024;
/** 白名单之外的文件一律拒,所以这道只防「拿几万个空条目撑爆解压」。 */
const MAX_PACKAGE_FILES = 64;
/**
 * 解压后的**总量**上限 —— 各单文件上限加起来会超过它,所以整包 10 MB 是更外层的硬顶。
 *
 * 🔴 光有单文件那条拦不住:白名单是**解压之后**才对的,那会儿 64 个各 8MB 的条目已经
 * 全解进内存了(镜像的堆只有 512MB)。皮肤包那头同一个位置有同一道闸,理由也一样。
 */
const MAX_PACKAGE_TOTAL_BYTES = MAX_EXTENSION_PACKAGE_BYTES;

/**
 * `locales/` 下的文件名只说「这是哪一种语言」,别的什么都不说。
 *
 * 首段小写、后续子段照 BCP 47 的字符集 —— `zh-CN.json` 认,`zh-cn.json` 也认(但不在
 * `LOCALES` 里,下面跳过);`notes.json` / `zh-CN.txt` 不认,照白名单整包拒。
 */
const EXTENSION_LOCALE_FILE_NAME = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\.json$/;

export interface OpenedExtensionPackage {
	/** 装到哪个目录名下 —— **清单说了算**,不看 zip 里的路径。 */
	id: string;
	manifest: ExtensionManifest;
	/** 清单原文。落盘写回去的是**这一份字节**,不是重新序列化的(键序会变)。 */
	manifestBytes: Uint8Array;
	entry: Uint8Array;
	/** 给人看的那两份,**两份都可选** —— 没写 README 不是装不了的理由。 */
	docs: { readme?: Uint8Array; changelog?: Uint8Array };
	/**
	 * 认下的译文。键是 `LOCALES` 里的语言码,落盘时也按这个键重建文件名 —— zip 里的名字
	 * 一个字都不拿来拼路径。
	 */
	locales: Partial<Record<Locale, Uint8Array>>;
	/** zip 里长得像语言码、但不在 `LOCALES` 里的条目:跳过不写,并在装包结果里告知。 */
	skippedLocales: string[];
}

/**
 * 「这两份文档值不值得给人看」—— 装完那句话后面要不要挂「看看说明」凭的就是它。
 *
 * 🔴 **只有空白等于没有**,判据要和面板那头的 `trim()` 一模一样:那头只有空白就整块不画,
 * 这头要是只看「文件在不在」,就会挂出一颗点进去什么都没有的钮 —— 正是这一格存在的理由
 * (别让界面自己猜)反过来咬自己。上传与从市场装两条路共用这一个,别各写各的。
 */
export function docsPresence(docs: OpenedExtensionPackage["docs"]): {
	readme: boolean;
	changelog: boolean;
} {
	const has = (bytes: Uint8Array | undefined): boolean =>
		bytes !== undefined && new TextDecoder().decode(bytes).trim().length > 0;
	return { readme: has(docs.readme), changelog: has(docs.changelog) };
}

/**
 * 拆包的结果。拆不开一律是 `invalid`(版本对不上是 `unsupported`):一句话就是 `message`;
 * 一串检查意见(白名单外的文件、清单没过校验)`message` 概括、`issues` 逐条 —— 那几句是主人手里
 * 那个包**哪里不对**的唯一线索。
 */
export type OpenExtensionPackageResult = Result<{ pkg: OpenedExtensionPackage }>;

/**
 * 剥掉「把目录整个拖进压缩软件」多出来的那一层。
 *
 * 只剥**所有条目共有的**那一层,而且只剥一层:剥多了等于允许 `a/b/index.mjs` 这种结构,
 * 而拓展包按定义是「清单 + 一个自包含入口 + 可选的文档与 `locales/`」,没有别的子目录。
 */
function commonPrefix(names: string[]): string {
	const heads = new Set(names.map((n) => (n.includes("/") ? n.slice(0, n.indexOf("/")) : "")));
	if (heads.size !== 1) return "";
	const only = [...heads][0] as string;
	return only === "" ? "" : `${only}/`;
}

export function openExtensionPackage(
	buf: Uint8Array,
	reservedIntegrationKeys: readonly string[],
): OpenExtensionPackageResult {
	let entries: Record<string, Uint8Array>;
	let precheck: string | null = null;
	let count = 0;
	let claimedTotal = 0;
	try {
		entries = unzipSync(buf, {
			filter: (f) => {
				if (isJunkZipEntry(f.name)) return false;
				count += 1;
				claimedTotal += f.originalSize;
				if (count > MAX_PACKAGE_FILES) {
					precheck = `包里的文件太多(上限 ${MAX_PACKAGE_FILES} 个)`;
					return false;
				}
				// 🔴 压缩炸弹:fflate 按 zip 头**声明**的解压大小先分配内存,再解压。上限得在这儿拦 ——
				// 解压完再量,一个 300KB 的包已经解出了 300MB。清单与入口各有各的顶,先按最宽的那档
				// 拦住撒谎的头,拆出来之后再按各自的顶细量。
				if (f.originalSize > MAX_CODE_BYTES) {
					precheck = `${f.name} 过大(声明的解压大小 ${Math.round(f.originalSize / 1024 / 1024)}MB,上限 ${Math.round(MAX_CODE_BYTES / 1024 / 1024)}MB)`;
					return false;
				}
				// 每个都合规、加起来不合规:说清是**总量**,别让主人去挨个文件找那个大的。
				if (claimedTotal > MAX_PACKAGE_TOTAL_BYTES) {
					precheck = `包解压后总量过大(声明的总解压大小 ${Math.round(claimedTotal / 1024 / 1024)}MB,上限 ${(MAX_PACKAGE_TOTAL_BYTES / 1024 / 1024).toFixed(1)}MB)`;
					return false;
				}
				return true;
			},
		});
	} catch {
		return fail("invalid", "这不是一个合法的 zip 文件");
	}
	if (precheck) return fail("invalid", precheck);

	const names = Object.keys(entries);
	if (names.length === 0) return fail("invalid", "这个 zip 是空的");
	// 🔴 `..` 一律不认,而且是在**剥前缀之前**判:`../` 也可能被当成共有前缀。
	const traversal = names.filter((name) => name.split("/").includes(".."));
	if (traversal.length > 0) {
		return fail("invalid", `包里的路径不许带 ..:${traversal.join("、")}`);
	}

	const prefix = commonPrefix(names);
	const errors: string[] = [];
	let manifestBytes: Uint8Array | undefined;
	let entry: Uint8Array | undefined;
	const docs: { readme?: Uint8Array; changelog?: Uint8Array } = {};
	const locales: Partial<Record<Locale, Uint8Array>> = {};
	const skippedLocales: string[] = [];
	let localesBytes = 0;
	const whitelistError = (name: string): string => `${name}:${t("extension.install.filesAllowed")}`;
	for (const [name, data] of Object.entries(entries)) {
		const inner = name.startsWith(prefix) ? name.slice(prefix.length) : name;
		if (inner === EXTENSION_MANIFEST_FILE) {
			if (data.byteLength > MAX_MANIFEST_BYTES) errors.push(`${EXTENSION_MANIFEST_FILE} 过大`);
			else manifestBytes = data;
		} else if (inner === EXTENSION_ENTRY_FILE) {
			if (data.byteLength > MAX_CODE_BYTES) {
				errors.push(
					`${EXTENSION_ENTRY_FILE} 过大(上限 ${Math.round(MAX_CODE_BYTES / 1024 / 1024)}MB)`,
				);
			} else entry = data;
		} else if (inner === EXTENSION_README_FILE || inner === EXTENSION_CHANGELOG_FILE) {
			/*
			 * 文档一样封顶(面板要整份读进来渲染),但超了**只丢这一份,不拒整个包** ——
			 * 它是纯装饰,没有任何代码路径会碰它;因为它太大就让一个功能完好的拓展装不上,
			 * 代价完全不对等。读回那头(`docs.ts`)本来就把「超上限」当「没有」,两端对得上。
			 */
			if (data.byteLength <= EXTENSION_DOC_MAX_BYTES) {
				if (inner === EXTENSION_README_FILE) docs.readme = data;
				else docs.changelog = data;
			}
		} else if (inner.startsWith(`${EXTENSION_LOCALES_DIR}/`)) {
			const file = inner.slice(EXTENSION_LOCALES_DIR.length + 1);
			if (file.includes("/") || !EXTENSION_LOCALE_FILE_NAME.test(file)) {
				errors.push(whitelistError(name));
				continue;
			}
			localesBytes += data.byteLength;
			if (data.byteLength > EXTENSION_LOCALE_FILE_MAX_BYTES) {
				errors.push(
					t("extension.install.localeTooLarge", {
						file: name,
						limit: "256 KB",
					}),
				);
				continue;
			}
			try {
				JSON.parse(strFromU8(data));
			} catch (err) {
				errors.push(
					t("extension.install.localeNotJson", {
						file: name,
						detail: (err as Error).message,
					}),
				);
				continue;
			}
			const code = file.slice(0, -".json".length);
			const locale = LOCALES.find((candidate) => candidate === code);
			if (locale === undefined) skippedLocales.push(inner);
			else locales[locale] = data;
		} else {
			// 白名单:落进装载目录的每一个文件都在一个会被 import 的目录里。
			errors.push(whitelistError(name));
		}
	}
	if (localesBytes > EXTENSION_LOCALES_TOTAL_MAX_BYTES) {
		errors.push(t("extension.install.localesTooLarge", { limit: "2 MB" }));
	}
	if (!manifestBytes && errors.length === 0) errors.push(`包里少了 ${EXTENSION_MANIFEST_FILE}`);
	if (!entry && errors.length === 0) errors.push(`包里少了 ${EXTENSION_ENTRY_FILE}`);
	if (errors.length > 0 || !manifestBytes || !entry) {
		return failureOfChecks("invalid", "这个拓展包", errors);
	}

	let raw: unknown;
	try {
		raw = JSON.parse(strFromU8(manifestBytes));
	} catch (err) {
		return fail("invalid", `${EXTENSION_MANIFEST_FILE} 不是合法 JSON:${(err as Error).message}`);
	}
	// 版本不合就在这儿拦,而且**先判它**:为将来的宿主写的清单,格式本来就可能是我们不认识
	// 的,挑它的毛病只会把「先升级 BN」说成一串「读不了」。装进去再在页面上显示 incompatible
	// 也不是不行,但**此刻**这句话最清楚:主人正拿着那个包,还能去换一个对的。
	const read = parseHostExtensionManifest(raw, EXTENSION_API_RANGE, reservedIntegrationKeys);
	if (!read.ok) {
		if (read.reason === "incompatible") {
			return fail("unsupported", apiVersionMismatch(read.requires, EXTENSION_API_RANGE));
		}
		return failureOfChecks(
			"invalid",
			"这个拓展包",
			read.issues.map((issue) => `${EXTENSION_MANIFEST_FILE} ${issue}`),
		);
	}

	return ok({
		pkg: {
			id: read.manifest.id,
			manifest: read.manifest,
			manifestBytes,
			entry,
			docs,
			locales,
			skippedLocales: skippedLocales.sort(),
		},
	});
}

export interface InstallExtensionPackageInput {
	/** 装载根 —— `<数据根>/extensions/`。不存在就建。 */
	root: string;
	pkg: OpenedExtensionPackage;
}

/**
 * 同一个装载根上的安装**排队**:两个标签页同时点「装」,各自 mkdtemp → rm → rename 交错起来,
 * 第二个 rename 会撞上第一个刚落好的目录(ENOTEMPTY),或者把它删掉。
 *
 * 线上的调用方都经装载器的 `changeDisk()` 进来,那条队已经把它们排开了;这一道留给不经装载器
 * 的调用(装载器还没起来的那一瞬、单测),便宜,不拆。
 */
const installQueues = new Map<string, Promise<unknown>>();

export interface UninstallExtensionInput {
	/** 装载根(`<数据根>/extensions`)。 */
	root: string;
	/** 拓展 id。调用方**必须**先按 `ExtensionIdSchema` 验过 —— 它同时是目录名。 */
	id: string;
}

/**
 * 卸的结果。`removed: false` = 盘上本来就没有,面板上的列表可能是上一秒的,这不算错;
 * 目标是软链则回 `conflict`。
 */
export type UninstallExtensionResult = Result<{ removed: boolean }>;

/**
 * 把一个拓展从装载根上抹掉。
 *
 * 🔴 **软链一律拒**,不顺着删下去:开发版里那条是 devtools 链进来的**仓库工作树**,
 * 顺着删就是删主人的源码。同 {@link installExtensionPackage} 那头的判据。
 *
 * 收摊(停掉正在跑的那份、删掉装载器里它那一格)不在这里 —— 那是重扫的活:它发现 id 从盘上
 * 消失就会自己做完,不必重启。调用方经装载器的 `changeDisk()` 调它,抹盘与重扫在队里是一件事。
 */
export async function uninstallExtension({
	root,
	id,
}: UninstallExtensionInput): Promise<UninstallExtensionResult> {
	const at = join(root, id);
	const existing = await lstat(at).catch(() => undefined);
	if (!existing) return ok({ removed: false });
	if (existing.isSymbolicLink()) {
		return fail(
			"conflict",
			`${id} 现在是一条软链(开发版 devtools 装的)—— 在 devtools 里卸掉它,别从这里删`,
		);
	}
	await rm(at, { recursive: true, force: true });
	return ok({ removed: true });
}

/**
 * 把拆好的包落到 `<root>/<id>/`。
 *
 * **先写到一个暂存目录再整体换过去**(存储层的整目录替换):直接往目标目录里逐个写的话,
 * 写到一半失败会留下一个「清单是新的、代码是旧的」的拓展,而那正是最难查的一种状态。同一个
 * 道理,覆盖时旧目录整个换下去、不在新目录里留一个字节 —— 留着上一版的残余文件,下一次谁也
 * 说不清跑的是哪一份。失败不留暂存,原来装着的那份原样还在;目标名字只经最后那一下改名出现。
 *
 * 🔴 暂存与被换下来的旧目录**沿用点开头的名字**(`.staging-<id>-…` / `.old-<id>-…`),不用存储层
 * 的默认名:装载器扫根时只按「点开头」跳过(`discover.ts`),默认名 `<id>.bn-tmp.…` 不带点,
 * 进程在改名之间被杀,它带着一份合法清单留下来,就是一张删不掉的 unreadable 卡。代价是存储层的
 * 开机清扫认不出这两种名字:两次改名之间被杀,会留下目标不在(「没装上」)、外加 `.staging-…` 与
 * `.old-…` 两个点开头的目录(装载器跳过、不显示),旧版本留在 `.old-…` 里不会自动挪回 —— 重传一次就好。
 *
 * 盖掉一份已经装着的**不等于「换不上」**:关着、从没跑过的那份盘上换了就是换了。换不换得上
 * 由装载器按入口指纹判(ADR-0012 决策 47),面板那句话照重扫之后装载器那一行的 `staged` 说。
 *
 * 目标是 devtools 链进来的软链时抛 {@link ExtensionConflictError}(可预期的拒绝,路由回 `conflict`);
 * 别的抛错是磁盘写失败之类,不是它,交给全局出错处理。
 */
export async function installExtensionPackage(input: InstallExtensionPackageInput): Promise<void> {
	const previous = installQueues.get(input.root) ?? Promise.resolve();
	const run = previous.catch(() => undefined).then(() => installExtensionPackageUnlocked(input));
	installQueues.set(input.root, run);
	try {
		await run;
	} finally {
		if (installQueues.get(input.root) === run) installQueues.delete(input.root);
	}
}

async function installExtensionPackageUnlocked(input: InstallExtensionPackageInput): Promise<void> {
	const { root, pkg } = input;
	const at = join(root, pkg.id);

	const existing = await lstat(at).catch(() => undefined);
	// 🔴 软链 = devtools 链进来的仓库工作树。往里写就是往 git 仓库里写。
	if (existing?.isSymbolicLink()) {
		throw new ExtensionConflictError(
			`${pkg.id} 现在是一条软链(开发版 devtools 装的)—— 先在 devtools 里卸掉它,再传包`,
		);
	}

	// 暂存目录建在装载根里(与目标同一个文件系统,改名才是原子的);根不存在时它一并建出来。
	const tag = randomBytes(6).toString("hex");
	await replaceDirectory(
		at,
		async (staging) => {
			await atomicWriteFile(join(staging, EXTENSION_MANIFEST_FILE), pkg.manifestBytes);
			await atomicWriteFile(join(staging, EXTENSION_ENTRY_FILE), pkg.entry);
			// 没带就**一个文件都不建** —— 空的 README.md 和没有 README 在面板上是两回事:
			// 前者会画出一块空白,后者整块不画。
			if (pkg.docs.readme) {
				await atomicWriteFile(join(staging, EXTENSION_README_FILE), pkg.docs.readme);
			}
			if (pkg.docs.changelog) {
				await atomicWriteFile(join(staging, EXTENSION_CHANGELOG_FILE), pkg.docs.changelog);
			}
			// 文件名按语言表重建,不看 zip 里的写法;不在表里的那几份连目录都不建。
			for (const locale of LOCALES) {
				const bytes = pkg.locales[locale];
				if (bytes) {
					await atomicWriteFile(join(staging, EXTENSION_LOCALES_DIR, `${locale}.json`), bytes);
				}
			}
		},
		{
			stagingPath: join(root, `.staging-${pkg.id}-${tag}`),
			oldPath: join(root, `.old-${pkg.id}-${tag}`),
		},
	);
}
