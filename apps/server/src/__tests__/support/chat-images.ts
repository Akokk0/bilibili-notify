import { join } from "node:path";
import type { ConversationStore } from "../../ai/conversation-store.js";
import { createImageStore, type ImageStore, type ImageWriter } from "../../images/image-store.js";
import { PNG_BYTES } from "./avatar-fixtures.js";

/**
 * 聊天路由测试用的图库:和 `runtime/bootstrap.ts` 一样,女仆对话登记成引用方、名单取自会话库。
 * 真装配里这一行是否写上了,由 `runtime/__tests__/chat-images-wiring.test.ts` 钉着。
 */
export function makeChatImages(
	dataDir: string,
	conversationStore: ConversationStore,
): { imageStore: ImageStore; chatImages: ImageWriter } {
	const imageStore = createImageStore({ dir: join(dataDir, "images") });
	const chatImages = imageStore.register({
		name: "女仆对话",
		listRefs: () => conversationStore.listImageRefs(),
	});
	return { imageStore, chatImages };
}

/**
 * 第 `n` 张互不相同的 PNG:真的 1×1 PNG 后面缀一个字节。图库按内容起名,字节一样就是同一张图,
 * 需要「几张不同的图」的用例要靠它。
 */
export function distinctPng(n: number): Buffer {
	return Buffer.concat([PNG_BYTES, Buffer.from([n])]);
}

/** 存一张图并回引用;存不进去直接抛(测试夹具不该走到失败这支)。 */
export async function putImage(writer: ImageWriter, bytes: Uint8Array): Promise<string> {
	const stored = await writer.put(bytes);
	if (!stored.ok) throw new Error(`夹具图存不进图库:${stored.message}`);
	return stored.ref;
}
