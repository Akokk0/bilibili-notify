/**
 * 往图库存图的小件;存图的口一律是 `Pick<ImageWriter, "put">`。
 */

import { fail, type ImageRef, ok } from "@bilibili-notify/internal";
import { type ImageWriter, imageRefOf } from "./image-store.js";

/**
 * **图的写盘推迟到出卡那一刻**(㉑e)。过滤吃翻好的 `Post`,所以翻译得排在过滤之前;可被屏蔽的、关了出图的、版式
 * 藏起卡片的作品根本不出卡,不该为它们往图库写盘。引用是内容哈希({@link imageRefOf},与真存图起的名字是同一份规矩),
 * 翻译时不用写就知道 —— `sink.put` 只算引用、把字节记下来,`commit()` 才真的存(出卡前调,多次调只写一次)。
 *
 * 图库不收的图(格式不认、超限)`put` 当场回 `invalid`,与真存一样;`commit` 时图库说存不进(磁盘写失败回的
 * `unavailable`、或与本地判断对不上)在这里抛出去,这一次出卡失败,装配降级成纯文字。
 */
export function deferImageWrites(writer: Pick<ImageWriter, "put">): {
	sink: Pick<ImageWriter, "put">;
	commit(): Promise<void>;
} {
	const pending = new Map<ImageRef, Uint8Array>();
	let committed: Promise<void> | undefined;
	return {
		sink: {
			async put(bytes) {
				const ref = imageRefOf(bytes);
				if (ref === undefined) {
					return fail("invalid", "不是图库收的图(只收 png / jpg / gif / webp,单张不超过 8 MiB)");
				}
				pending.set(ref, bytes);
				return ok({ ref });
			},
		},
		commit() {
			committed ??= (async () => {
				for (const [ref, bytes] of pending) {
					const stored = await writer.put(bytes);
					if (!stored.ok) throw new Error(`作品配图存不进图库:${stored.message}`);
					if (stored.ref !== ref) {
						throw new Error(`作品配图的引用对不上:算出 ${ref},图库给 ${stored.ref}`);
					}
				}
			})();
			return committed;
		},
	};
}

/**
 * 存一张图,回引用;图库不收(`invalid`:格式不认、超限)回 `undefined`,那一格缺着。别的失败(磁盘写失败回的
 * `unavailable`)抛 —— 与 {@link deferImageWrites} 的 `commit()` 同一个口径:这一次出卡失败,装配降级成纯文字,
 * 不是悄悄少一张图。拓展直播卡(`liveCardInputFromReport`)拿到的口是 `deferImageWrites` 的 `sink`(不碰盘,只回 ok / `invalid`),
 * 走不到抛的那一支;拓展作品那条路拿的是真写口,绑定在自己给的口里把 `unavailable` 接成「那张图缺着」,也走不到。
 * 抛的这一支防的是别的调用方把真图库的口直接传进来。
 */
export async function storeOrSkip(
	images: Pick<ImageWriter, "put">,
	bytes: Uint8Array,
): Promise<ImageRef | undefined> {
	const stored = await images.put(bytes);
	if (stored.ok) return stored.ref;
	if (stored.code === "invalid") return undefined;
	throw new Error(`图存不进图库:${stored.message}`);
}
