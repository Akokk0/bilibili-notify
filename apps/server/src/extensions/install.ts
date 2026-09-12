/**
 * 从一个 zip 装拓展 —— 面板上那条「传一个包上来」。
 *
 * 🔴 **这条路把「往装载目录里放代码」从文件系统权限降到了一次面板会话**,而放进去的东西
 * 是会被 `import` 的。所以拆包这一层是一道**真闸**,不是格式转换:
 * ① **白名单收文件** —— 只认清单与入口,夹带的一律整包拒绝(黑名单永远漏);
 * ② **目录名只来自清单里那个 id**,而它已经过了 `ExtensionIdSchema` 的正则 —— zip 里的
 *    路径是打包的人写的,一个字都不拿来拼路径;
 * ③ 层数、大小、文件数都封顶。
 *
 * ⚠️ 装的时候**不验签**:签名分发那条链(ADR-0005 那套)还没建。所以第一版信的是「能登进
 * 这个面板的人」—— 与「主人自己把目录拷进 `<dataDir>/extensions/`」同一档信任,只是省了
 * 一次 ssh。UI 上那句「只装信得过的包」不是客套。
 */

import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	EXTENSION_API_VERSION,
	type ExtensionManifest,
	ExtensionManifestSchema,
} from "@bilibili-notify/internal";
import { strFromU8, unzipSync } from "fflate";
import { isJunkZipEntry } from "../zip-junk.js";
import {
	EXTENSION_CHANGELOG_FILE,
	EXTENSION_DOC_MAX_BYTES,
	EXTENSION_ENTRY_FILE,
	EXTENSION_MANIFEST_FILE,
	EXTENSION_README_FILE,
} from "./discover.js";

/** 清单顶天几百字节,给到 512KB 是留给 icon 那段 SVG(它自己的上限是 64KB)。 */
const MAX_MANIFEST_BYTES = 512 * 1024;
/** 自包含 bundle:桥内联完第三方也就将近 300KB。8MB 已经宽得离谱,再大多半是打错了。 */
const MAX_CODE_BYTES = 8 * 1024 * 1024;
/** 进这道门的整包上限(路由那道闸用它),留足给未来的多文件包。 */
export const MAX_EXTENSION_PACKAGE_BYTES = 10 * 1024 * 1024;
/** 白名单之外的文件一律拒,所以这道只防「拿几万个空条目撑爆解压」。 */
const MAX_PACKAGE_FILES = 64;
/**
 * 解压后的**总量**上限 —— 合法的包就那四个名字,四条单文件上限加起来正好是它。
 *
 * 🔴 光有单文件那条拦不住:白名单是**解压之后**才对的,那会儿 64 个各 8MB 的条目已经
 * 全解进内存了(镜像的堆只有 512MB)。皮肤包那头同一个位置有同一道闸,理由也一样。
 */
const MAX_PACKAGE_TOTAL_BYTES = MAX_MANIFEST_BYTES + MAX_CODE_BYTES + 2 * EXTENSION_DOC_MAX_BYTES;

export interface OpenedExtensionPackage {
	/** 装到哪个目录名下 —— **清单说了算**,不看 zip 里的路径。 */
	id: string;
	manifest: ExtensionManifest;
	/** 清单原文。落盘写回去的是**这一份字节**,不是重新序列化的(键序会变)。 */
	manifestBytes: Uint8Array;
	entry: Uint8Array;
	/** 给人看的那两份,**两份都可选** —— 没写 README 不是装不了的理由。 */
	docs: { readme?: Uint8Array; changelog?: Uint8Array };
}

export type OpenExtensionPackageResult =
	| { ok: true; pkg: OpenedExtensionPackage }
	| { ok: false; errors: string[] };

/**
 * 剥掉「把目录整个拖进压缩软件」多出来的那一层。
 *
 * 只剥**所有条目共有的**那一层,而且只剥一层:剥多了等于允许 `a/b/index.mjs` 这种结构,
 * 而拓展包按定义是「清单 + 一个自包含入口」,没有子目录。
 */
function commonPrefix(names: string[]): string {
	const heads = new Set(names.map((n) => (n.includes("/") ? n.slice(0, n.indexOf("/")) : "")));
	if (heads.size !== 1) return "";
	const only = [...heads][0] as string;
	return only === "" ? "" : `${only}/`;
}

export function openExtensionPackage(buf: Uint8Array): OpenExtensionPackageResult {
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
		return { ok: false, errors: ["这不是一个合法的 zip 文件"] };
	}
	if (precheck) return { ok: false, errors: [precheck] };

	const names = Object.keys(entries);
	if (names.length === 0) return { ok: false, errors: ["这个 zip 是空的"] };
	// 🔴 `..` 一律不认,而且是在**剥前缀之前**判:`../` 也可能被当成共有前缀。
	const traversal = names.filter((name) => name.split("/").includes(".."));
	if (traversal.length > 0) {
		return { ok: false, errors: [`包里的路径不许带 ..:${traversal.join("、")}`] };
	}

	const prefix = commonPrefix(names);
	const errors: string[] = [];
	let manifestBytes: Uint8Array | undefined;
	let entry: Uint8Array | undefined;
	const docs: { readme?: Uint8Array; changelog?: Uint8Array } = {};
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
		} else {
			// 白名单:落进装载目录的每一个文件都在一个会被 import 的目录里。
			errors.push(
				`${name}:拓展包里只能有 ${EXTENSION_MANIFEST_FILE}、${EXTENSION_ENTRY_FILE}` +
					`,外加可选的 ${EXTENSION_README_FILE} 与 ${EXTENSION_CHANGELOG_FILE}`,
			);
		}
	}
	if (!manifestBytes && errors.length === 0) errors.push(`包里少了 ${EXTENSION_MANIFEST_FILE}`);
	if (!entry && errors.length === 0) errors.push(`包里少了 ${EXTENSION_ENTRY_FILE}`);
	if (errors.length > 0 || !manifestBytes || !entry) return { ok: false, errors };

	let raw: unknown;
	try {
		raw = JSON.parse(strFromU8(manifestBytes));
	} catch (err) {
		return {
			ok: false,
			errors: [`${EXTENSION_MANIFEST_FILE} 不是合法 JSON:${(err as Error).message}`],
		};
	}
	const parsed = ExtensionManifestSchema.safeParse(raw);
	if (!parsed.success) {
		return {
			ok: false,
			errors: parsed.error.issues.map(
				(issue) => `${EXTENSION_MANIFEST_FILE} ${issue.path.join(".") || "(根)"}: ${issue.message}`,
			),
		};
	}
	// 版本不合就在这儿拦。装进去再在页面上显示 incompatible 也不是不行,但**此刻**这句话
	// 最清楚:主人正拿着那个包,还能去换一个对的。
	if (parsed.data.apiVersion !== EXTENSION_API_VERSION) {
		return {
			ok: false,
			errors: [
				`它要宿主契约 v${parsed.data.apiVersion},这一版是 v${EXTENSION_API_VERSION} —— 换一个匹配的包`,
			],
		};
	}

	return {
		ok: true,
		pkg: { id: parsed.data.id, manifest: parsed.data, manifestBytes, entry, docs },
	};
}

export interface InstallExtensionPackageInput {
	/** 装载根 —— `<dataDir>/extensions/`。不存在就建。 */
	root: string;
	pkg: OpenedExtensionPackage;
}

export interface InstallExtensionPackageResult {
	/** 盖掉了一份已经装着的 → 代码在这个进程里换不掉,调用方要据此说「得重启」。 */
	replaced: boolean;
}

/**
 * 把拆好的包落到 `<root>/<id>/`。
 *
 * **先写到一个临时目录再整体换过去**:直接往目标目录里逐个写的话,写到一半失败会留下
 * 一个「清单是新的、代码是旧的」的拓展,而那正是最难查的一种状态。同一个道理,覆盖时
 * 先把旧目录整个删掉 —— 留着上一版的残余文件,下一次谁也说不清跑的是哪一份。
 */
/**
 * 同一个装载根上的安装**排队**:路由层没有锁,两个标签页同时点「装」,各自 mkdtemp → rm →
 * rename 交错起来,第二个 rename 会撞上第一个刚落好的目录(ENOTEMPTY),或者把它删掉。
 */
const installQueues = new Map<string, Promise<unknown>>();

export interface UninstallExtensionInput {
	/** 装载根(`<dataDir>/extensions`)。 */
	root: string;
	/** 拓展 id。调用方**必须**先按 `ExtensionIdSchema` 验过 —— 它同时是目录名。 */
	id: string;
}

export type UninstallExtensionResult =
	/** `removed: false` = 盘上本来就没有。面板上的列表可能是上一秒的,这不算错。 */
	{ ok: true; removed: boolean } | { ok: false; err: string };

/**
 * 把一个拓展从装载根上抹掉。
 *
 * 🔴 **软链一律拒**,不顺着删下去:开发版里那条是 devtools 链进来的**仓库工作树**,
 * 顺着删就是删主人的源码。同 {@link installExtensionPackage} 那头的判据。
 *
 * 收摊(停掉正在跑的那份、清掉装载器的三张表)不在这里 —— 那是 `rescan()` 的活:
 * 它发现 id 从盘上消失就会自己做完,所以删完调一次即可,不必重启。
 */
export async function uninstallExtension({
	root,
	id,
}: UninstallExtensionInput): Promise<UninstallExtensionResult> {
	const at = join(root, id);
	const existing = await lstat(at).catch(() => undefined);
	if (!existing) return { ok: true, removed: false };
	if (existing.isSymbolicLink()) {
		return {
			ok: false,
			err: `${id} 现在是一条软链(开发版 devtools 装的)—— 在 devtools 里卸掉它,别从这里删`,
		};
	}
	await rm(at, { recursive: true, force: true });
	return { ok: true, removed: true };
}

export async function installExtensionPackage(
	input: InstallExtensionPackageInput,
): Promise<InstallExtensionPackageResult> {
	const previous = installQueues.get(input.root) ?? Promise.resolve();
	const run = previous.catch(() => undefined).then(() => installExtensionPackageUnlocked(input));
	installQueues.set(input.root, run);
	try {
		return await run;
	} finally {
		if (installQueues.get(input.root) === run) installQueues.delete(input.root);
	}
}

async function installExtensionPackageUnlocked(
	input: InstallExtensionPackageInput,
): Promise<InstallExtensionPackageResult> {
	const { root, pkg } = input;
	const at = join(root, pkg.id);
	await mkdir(root, { recursive: true });

	const existing = await lstat(at).catch(() => undefined);
	// 🔴 软链 = devtools 链进来的仓库工作树。往里写就是往 git 仓库里写。
	if (existing?.isSymbolicLink()) {
		throw new Error(
			`${pkg.id} 现在是一条软链(开发版 devtools 装的)—— 先在 devtools 里卸掉它,再传包`,
		);
	}

	const staging = await mkdtemp(join(root, `.staging-${pkg.id}-`));
	try {
		await writeFile(join(staging, EXTENSION_MANIFEST_FILE), pkg.manifestBytes);
		await writeFile(join(staging, EXTENSION_ENTRY_FILE), pkg.entry);
		// 没带就**一个文件都不建** —— 空的 README.md 和没有 README 在面板上是两回事:
		// 前者会画出一块空白,后者整块不画。
		if (pkg.docs.readme) await writeFile(join(staging, EXTENSION_README_FILE), pkg.docs.readme);
		if (pkg.docs.changelog) {
			await writeFile(join(staging, EXTENSION_CHANGELOG_FILE), pkg.docs.changelog);
		}
		// rename 到一个已存在的目录在各平台上表现不一,一律先删。这一步之后到 rename 之间
		// 断电会留下「没装上」—— 那是三种结局里最好说清的一种。
		if (existing) await rm(at, { recursive: true, force: true });
		await rename(staging, at);
	} finally {
		// rename 成功之后 staging 已经不在了;失败时它必须消失 —— 装载器会把留在装载根里的
		// 任何一个目录当成一个拓展去扫。
		await rm(staging, { recursive: true, force: true });
	}
	return { replaced: Boolean(existing) };
}
