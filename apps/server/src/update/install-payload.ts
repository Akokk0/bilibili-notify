import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fail, ok, type Result } from "@bilibili-notify/internal";
import { atomicWriteFile, replaceDirectory } from "@bilibili-notify/storage";
import { unzipSync } from "fflate";
import { t } from "../i18n/index.js";

export interface InstallPayloadOptions {
	/** 升级包的原始字节(ZIP)。 */
	zip: Uint8Array;
	/** 清单里声明的 sha256(hex)。清单本身已经验过签,所以这个值是可信的。 */
	expectedSha256: string;
	version: string;
	/** 版本目录的根,如 `/data/versions`。 */
	versionsRoot: string;
}

export type InstallPayloadResult = Result<{ path: string; alreadyInstalled: boolean }>;

/** 版本目录里记「这是哪份包」的文件名。 */
const SHA_MARKER = ".payload-sha256";

/**
 * 条目名会不会写到 `root` 外面。`../` 和绝对路径都由这一句拦下 —— `resolve`
 * 是纯词法的,不碰磁盘。
 */
function escapesRoot(root: string, entryName: string): boolean {
	// 根先算成绝对路径:`resolve(root, entry)` 出来的一定是绝对路径,拿它跟一个相对的
	// 根比前缀,每个条目都会被判成越界 —— 配置里 dataDir 默认就是 `./data`。
	const base = resolve(root);
	const resolved = resolve(base, entryName);
	return resolved !== base && !resolved.startsWith(base + sep);
}

/**
 * 把升级包装进 `versionsRoot/<version>/`。
 *
 * **唯一的一条保证:要么那个目录完整出现,要么现场一个字节没动。** 中间态不落盘
 * —— 启动选版会把任何一个存在的版本目录当成可用版本,留下半个树等于给下次启动
 * 埋一颗雷。
 *
 * 整目录替换与逐文件落盘都交给 `@bilibili-notify/storage`:暂存里每个文件(连同 sha 标记)
 * 都是写完 fsync 再改名,所以掉电之后不会有空文件躺在一个「完整」的版本目录里。
 */
export async function installPayload({
	zip,
	expectedSha256,
	version,
	versionsRoot,
}: InstallPayloadOptions): Promise<InstallPayloadResult> {
	const target = join(versionsRoot, version);

	// 同一份包已经装过就什么都不做。「同一份」看目录里记的 sha256,不只看目录在不在:
	// 发版侧重传过资产的话,同版本号下面是另一个包 —— 只认目录存在的话,7MB 白下、盘上
	// 还是旧那份、上层却记着新 sha,面板说已就绪,重启跑的是旧的。
	// 版本目录只可能通过原子 rename 出现,所以它存在就说明内容是完整的。
	if (existsSync(target) && readInstalledSha256(target) === expectedSha256) {
		return ok({ path: target, alreadyInstalled: true });
	}

	// 校验在**落盘之前**。反过来的话,失败那一刻磁盘上已经躺着半个树了。
	const actual = createHash("sha256").update(zip).digest("hex");
	if (actual !== expectedSha256) return fail("conflict", t("update.validation.checksum"));

	// 先整个解进 staging,**最后一次 rename 才让它以目标名字出现**。rename 在同一
	// 文件系统内是原子的,所以启动选版永远看不到半个树。
	//
	// 🔴 暂存与旧目录的名字**必须**是 `.staging-<版本>-<uuid>` / `.old-<版本>-<uuid>`:已发出去的
	// `prune-versions` 与 `version-dirs` 的 `LEFTOVER_DIR_RE` 按这两个前缀认残留(冻住的 boot.mjs
	// 也一样),换成存储层默认的 `.bn-tmp.` / `.bn-old.` 名字,进程被杀留下的 25MB 就再没人收。
	// 名字自定义了,开机清扫就认不出它们 —— 收残留的仍是 prune。
	const staging = join(versionsRoot, `.staging-${version}-${randomUUID()}`);
	const old = join(versionsRoot, `.old-${version}-${randomUUID()}`);

	// 解的是**要被执行的代码**,所以条目名先全验一遍再动手写:一个会往外写的包,
	// 剩下那些条目也不值得信,而且「先写几个再拒绝」等于自己造出半个树。
	let entries: [string, Uint8Array][];
	try {
		entries = Object.entries(unzipSync(zip)).filter(([name]) => !name.endsWith("/"));
	} catch {
		// sha256 对得上只证明「字节是清单说的那一份」,不证明那份字节解得开。
		return fail("invalid", t("update.validation.extract"));
	}
	if (entries.some(([name]) => escapesRoot(staging, name))) {
		return fail("invalid", t("update.validation.unsafeEntry"));
	}

	try {
		// 目标已存在(同版本号换包)时 POSIX 的 rename 会报 ENOTEMPTY,只能「挪走旧的 → 改名新的
		// → 删旧的」—— 中间有一个两者都不在目标名字上的窗口。窗口里进程死了的话,启动选版看不到
		// 这一版,会退到下一个候选(可活),而挪走的 `.old-*` 由 prune 扫掉。第二步失败就把旧的
		// 挪回来,尽量别留空;搭建中途失败原目录不动、暂存由存储层删掉。
		await replaceDirectory(
			target,
			async (stagingDir) => {
				// 顺序写:一个文件写完 fsync 再写下一个。
				for (const [name, bytes] of entries) {
					await atomicWriteFile(join(stagingDir, name), bytes);
				}
				// 记下这份包的 sha256,跟着目录一起原子出现 —— 下次同版本号再来,凭它判断是不是同一份。
				await atomicWriteFile(join(stagingDir, SHA_MARKER), expectedSha256);
			},
			{ stagingPath: staging, oldPath: old },
		);
	} catch {
		// 包是从网上下来的,畸形结构(同名的文件与目录、磁盘满、权限)都只能是
		// 「装不上」,不能是「进程没了」。暂存目录存储层已经收走。
		return fail("unavailable", t("update.validation.extract"));
	}

	return ok({ path: target, alreadyInstalled: false });
}

/** 目录里记的「这是哪份包」。没有(更早的版本装的)或读不出来 → 当作不是同一份。 */
function readInstalledSha256(dir: string): string | null {
	try {
		return readFileSync(join(dir, SHA_MARKER), "utf8").trim();
	} catch {
		return null;
	}
}
