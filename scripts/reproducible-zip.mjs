/**
 * 发版侧打包的两件小事:**算摘要**和**打一个可复现的 zip**。
 *
 * 三条流水线(拓展包、升级载荷、撤回时回头核对一份已发布的包)各自都要「sha256 + 字节数」
 * 这一对,而它们必须是同一种算法的同一种写法 —— 一边算 hex 一边算 base64 的那天,
 * 客户端报的是 `checksum-mismatch`,也就是我们专门留给「有人在中间改包」的那一档归因。
 *
 * ⛔ **两个 epoch 不许统一**。固定 mtime 是「同样的输入打出同样的字节」的唯一条件,而
 * 各自的值已经烧进了**已经发出去的包**的 sha256 里:动了哪一个,重跑那条老 tag 打出来的
 * 字节就和当初发出去的不一样,而流水线全绿 —— 只有在「这两个包是不是同一个东西」被追问的
 * 那天才发现。所以这里给两个常量,不给一个默认值。
 */

import { createHash } from "node:crypto";
import { zipSync } from "fflate";

/** 拓展包的 mtime。 */
export const EXTENSION_ZIP_EPOCH = new Date("2000-01-01T00:00:00Z");

/** 升级载荷的 mtime。zip 格式能表示的最早时间 —— 它给不了 epoch 0。 */
export const PAYLOAD_ZIP_EPOCH = new Date("1980-01-01T00:00:00Z");

/**
 * 一份字节的 sha256(小写 hex)与大小 —— 清单 / 索引要的就是这一对。
 *
 * @param {Uint8Array} bytes
 * @returns {{ sha256: string, size: number }}
 */
export function digestOf(bytes) {
	return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
}

/**
 * 打一个**可复现**的 zip:同样的输入打出同样的字节。
 *
 * @param {Record<string, Uint8Array>} files zip 里的路径 → 内容。路径一律 posix 分隔符。
 * @param {Date} epoch 见上面那两个常量,调用方按自己那条发布链选,别换。
 * @returns {Uint8Array}
 */
export function reproducibleZip(files, epoch) {
	return zipSync(files, { level: 9, mtime: epoch });
}
