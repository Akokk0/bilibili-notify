/**
 * 一次性取图口的存储那一半 —— `send` 帧里那条 `/bridge/blob/<id>` URL 背后的东西。
 *
 * 图为什么不能直接进帧:{@link NotificationPayload} 里的图是 `Buffer`,过不了 JSON。
 * base64 塞进帧倒是能过,但一条 WS 帧就得驮着整张卡的字节,而桥那侧多半还要再解一遍
 * 才能交给平台 —— 换成一条 URL,桥想怎么取怎么取。
 *
 * ⚠️ 这条 URL **只保证桥自己可达**(协议文档 §9 那段大写的警告)。URL 是拿**那条桥
 * 自己连进来时用的地址**拼的(见 `BridgeSession.origin`),所以「可达」这件事是结构上
 * 成立的,不靠谁记得配对。
 *
 * **id 即凭据**:128 位随机、取过即焚、短 TTL。所以这个口不挂鉴权 —— 挂了反而怪:
 * 桥手里只有一条 URL,没有 dashboard 的会话。
 */

import { randomBytes } from "node:crypto";
import type { ServiceContext } from "@bilibili-notify/internal";

/** 取图口的路径前缀。路由挂在这儿,URL 也按它拼 —— 两处写岔了就是 404。 */
export const BRIDGE_BLOB_PATH = "/bridge/blob";

/**
 * 一张图能等多久。`send` 的回执窗口是 30 秒(桥要下载大图),给它两倍 —— 桥取图必然
 * 发生在那个窗口里,过了还没来取就是不会来了。
 */
export const DEFAULT_BRIDGE_BLOB_TTL_MS = 60_000;

/** 攒着的图最多占多少内存。到顶了淘汰最老的 —— 桥一直不来取也不能把内存吃光。 */
export const DEFAULT_BRIDGE_BLOB_MAX_BYTES = 64 * 1024 * 1024;

export interface BridgeBlob {
	buffer: Buffer;
	mime: string;
}

export interface BridgeBlobStore {
	/** 存一张图,给一个一次性 id。URL 由调用方拼 —— 它才知道**这条桥**从哪个地址进来。 */
	put(buffer: Buffer, mime: string): string;
	/** 取走。**取过就没了**;过期、取过、没见过都是 undefined。 */
	take(id: string): BridgeBlob | undefined;
	/** 现在攒着几张。排障与测试用。 */
	readonly size: number;
	dispose(): void;
}

export interface BridgeBlobStoreOptions {
	serviceCtx: ServiceContext;
	ttlMs?: number;
	maxBytes?: number;
	now?: () => number;
}

interface Entry {
	buffer: Buffer;
	mime: string;
	expiresAt: number;
}

export function createBridgeBlobStore(opts: BridgeBlobStoreOptions): BridgeBlobStore {
	const ttlMs = opts.ttlMs ?? DEFAULT_BRIDGE_BLOB_TTL_MS;
	const maxBytes = opts.maxBytes ?? DEFAULT_BRIDGE_BLOB_MAX_BYTES;
	const now = opts.now ?? (() => Date.now());
	// Map 记着插入顺序,所以「最老的」就是第一个键 —— 淘汰不用另攒一份顺序表。
	const blobs = new Map<string, Entry>();
	let bytes = 0;

	function drop(id: string, entry: Entry): void {
		blobs.delete(id);
		bytes -= entry.buffer.byteLength;
	}

	/**
	 * 主动扫过期的,而不是等谁来取才判。桥没来取的那些没人会碰它们 —— 懒判等于让它们
	 * 一直占着,而这个功能的图是整张卡片,几百 KB 一张。
	 */
	function sweep(): void {
		const t = now();
		for (const [id, entry] of blobs) {
			if (entry.expiresAt <= t) drop(id, entry);
		}
	}

	const sweeper = opts.serviceCtx.setInterval(sweep, Math.max(1_000, Math.floor(ttlMs / 2)));

	return {
		put(buffer, mime) {
			const id = randomBytes(16).toString("hex");
			blobs.set(id, { buffer, mime, expiresAt: now() + ttlMs });
			bytes += buffer.byteLength;
			// 先扫一遍过期的再谈淘汰:没这一下,过期但还没被扫走的那些会把活着的挤出去。
			if (bytes > maxBytes) sweep();
			while (bytes > maxBytes) {
				const oldest = blobs.entries().next();
				if (oldest.done) break;
				drop(oldest.value[0], oldest.value[1]);
			}
			return id;
		},

		take(id) {
			const entry = blobs.get(id);
			if (!entry) return undefined;
			drop(id, entry);
			// 过期的当没有 —— 已经从表里摘掉了,所以过期这件事只判这一次。
			if (entry.expiresAt <= now()) return undefined;
			return { buffer: entry.buffer, mime: entry.mime };
		},

		get size() {
			return blobs.size;
		},

		dispose() {
			sweeper.dispose();
			blobs.clear();
			bytes = 0;
		},
	};
}
