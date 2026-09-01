import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync } from "fflate";

export interface InstallPayloadInput {
	/** 升级包的原始字节(ZIP)。 */
	zip: Uint8Array;
	/** 清单里声明的 sha256(hex)。清单本身已经验过签,所以这个值是可信的。 */
	expectedSha256: string;
	version: string;
	/** 版本目录的根,如 `/data/versions`。 */
	versionsRoot: string;
}

export type InstallPayloadResult =
	| {
			ok: true;
			path: string;
			/** 目标版本本来就在,这次没碰磁盘。上层照样可以把指针切过去。 */
			alreadyInstalled: boolean;
	  }
	/** 字节和清单声明的不一致 —— 传输坏了,或者被中间人换过。 */
	| { ok: false; reason: "checksum-mismatch" }
	/** 包里有条目会写到版本目录外面 —— 整包不要。 */
	| { ok: false; reason: "unsafe-entry" }
	/** 包解不开,或者写到一半失败了。现场已经清干净。 */
	| { ok: false; reason: "extract-failed" };

/**
 * 条目名会不会写到 `root` 外面。`../` 和绝对路径都由这一句拦下 —— `resolve`
 * 是纯词法的,不碰磁盘。
 */
function escapesRoot(root: string, entryName: string): boolean {
	const resolved = resolve(root, entryName);
	return resolved !== root && !resolved.startsWith(root + sep);
}

/**
 * 把升级包装进 `versionsRoot/<version>/`。
 *
 * **唯一的一条保证:要么那个目录完整出现,要么现场一个字节没动。** 中间态不落盘
 * —— 启动选版会把任何一个存在的版本目录当成可用版本,留下半个树等于给下次启动
 * 埋一颗雷。
 */
export function installPayload({
	zip,
	expectedSha256,
	version,
	versionsRoot,
}: InstallPayloadInput): InstallPayloadResult {
	const target = join(versionsRoot, version);

	// 已经装过就什么都不做。版本目录只可能通过原子 rename 出现,所以它存在就说明
	// 内容是完整的 —— 重下重装一遍纯属浪费。而且目录**替换不了**:POSIX 的 rename
	// 目标是非空目录时直接 ENOTEMPTY,真要覆盖只能「挪走旧的→改名新的→删旧的」,
	// 中间必然有一个两者都不在目标名字上的窗口。为一个不该发生的场景开那个窗口
	// 不划算。「已存在但其实是坏的」交给启动失败自愈去清,不在这一层解决。
	if (existsSync(target)) return { ok: true, path: target, alreadyInstalled: true };

	// 校验在**落盘之前**。反过来的话,失败那一刻磁盘上已经躺着半个树了。
	const actual = createHash("sha256").update(zip).digest("hex");
	if (actual !== expectedSha256) return { ok: false, reason: "checksum-mismatch" };

	// 先整个解进 staging,**最后一次 rename 才让它以目标名字出现**。rename 在同一
	// 文件系统内是原子的,所以启动选版永远看不到半个树。
	const staging = join(versionsRoot, `.staging-${version}-${randomUUID()}`);

	// 解的是**要被执行的代码**,所以条目名先全验一遍再动手写:一个会往外写的包,
	// 剩下那些条目也不值得信,而且「先写几个再拒绝」等于自己造出半个树。
	let entries: [string, Uint8Array][];
	try {
		entries = Object.entries(unzipSync(zip)).filter(([name]) => !name.endsWith("/"));
	} catch {
		// sha256 对得上只证明「字节是清单说的那一份」,不证明那份字节解得开。
		return { ok: false, reason: "extract-failed" };
	}
	if (entries.some(([name]) => escapesRoot(staging, name))) {
		return { ok: false, reason: "unsafe-entry" };
	}

	try {
		mkdirSync(staging, { recursive: true });
		for (const [name, bytes] of entries) {
			const dest = join(staging, name);
			mkdirSync(dirname(dest), { recursive: true });
			writeFileSync(dest, bytes);
		}
		renameSync(staging, target);
	} catch {
		// 包是从网上下来的,畸形结构(同名的文件与目录、磁盘满、权限)都只能是
		// 「装不上」,不能是「进程没了」。staging 由下面的 finally 收走。
		return { ok: false, reason: "extract-failed" };
	} finally {
		// rename 成功后 staging 已经不在了,force 让这一句在两条路径上都安全。
		rmSync(staging, { recursive: true, force: true });
	}

	return { ok: true, path: target, alreadyInstalled: false };
}
