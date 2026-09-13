/**
 * 收不可信 zip 的**共用卫生层**:什么条目不算内容,以及怎么把一个包摊开而不被压缩
 * 炸弹撑爆。白名单、各自的单文件上限、落盘形状仍归各家(dashboard 皮肤包、卡片皮肤包、
 * 拓展包各不相同),这里只留三家都一模一样的那两件事。
 */

import { unzipSync } from "fflate";

/**
 * 压缩包里那些**不算内容**的条目:目录项本身、macOS 打包时塞进来的 `__MACOSX/`、
 * 以及 Finder 在每个目录里留的 `.DS_Store`。
 *
 * 皮肤包与拓展包的白名单、上限、落盘各不相同,但「什么不算一个文件」是同一件事。
 * 两处分头写的话,哪天多认一种垃圾只会改到一边 —— 而另一边会把它当成**夹带文件**
 * 整包拒掉,症状只在某一类用户的机器上出现。
 */
export function isJunkZipEntry(name: string): boolean {
	return (
		name.endsWith("/") || name.startsWith("__MACOSX/") || name.split("/").pop() === ".DS_Store"
	);
}

/** {@link openZipEntries} 的两道闸。默认值一个都没有 —— 每种包自己想清楚。 */
export interface OpenZipLimits {
	/** 包内最多几个条目(垃圾条目不计)。 */
	maxFiles: number;
	/** 解压后**总量**上限,按 zip 头声明的大小预筛。 */
	maxTotalBytes: number;
}

export type OpenZipResult =
	| { ok: true; entries: Record<string, Uint8Array> }
	| { ok: false; error: string };

/**
 * 摊开一个不可信 zip:垃圾条目滤掉,两道粗筛在**解压之前**拦住压缩炸弹。
 *
 * 🔴 闸必须下在 filter 里:fflate 按 zip 头**声明**的解压大小先分配内存、再解压 ——
 * 解压完再量的话,一个 300KB 的包已经解出了 300MB(镜像的堆只有 512MB)。头会撒谎,
 * 所以这只是粗筛:各家拿到 entries 之后,还得按真实 `byteLength` 复核自己那几条线。
 */
export function openZipEntries(buf: Uint8Array, limits: OpenZipLimits): OpenZipResult {
	let entries: Record<string, Uint8Array>;
	let precheckError: string | null = null;
	let count = 0;
	let claimedTotal = 0;
	try {
		entries = unzipSync(buf, {
			filter: (f) => {
				if (isJunkZipEntry(f.name)) return false;
				count += 1;
				claimedTotal += f.originalSize;
				if (count > limits.maxFiles) {
					precheckError = `包内文件太多(上限 ${limits.maxFiles} 个)`;
					return false;
				}
				if (claimedTotal > limits.maxTotalBytes) {
					precheckError = "包解压后总大小超限";
					return false;
				}
				return true;
			},
		});
	} catch {
		return { ok: false, error: "不是合法的 zip 文件" };
	}
	if (precheckError) return { ok: false, error: precheckError };
	return { ok: true, entries };
}
