import { join } from "node:path";
import { listRepushImageRefs } from "../../history/repush-store.js";
import { listHistoryImageRefs } from "../../history/retention.js";
import { createImageStore, type ImageStore, type ImageWriter } from "../../images/image-store.js";

/**
 * 历史相关测试用的图库:和 `runtime/bootstrap.ts` 一样,推送历史与重推原件各登记成引用方、名单直接读盘。
 * 真装配里这两行是否写上了,由 `runtime/__tests__/history-images-wiring.test.ts` 钉着。
 * 图库目录在 `<dataRoot>/images`(同真装配)。
 */
export function makeHistoryImages(dataRoot: string): {
	imageStore: ImageStore;
	historyImages: ImageWriter;
	repushImages: ImageWriter;
} {
	const imageStore = createImageStore({ dir: join(dataRoot, "images") });
	const historyImages = imageStore.register({
		name: "推送历史",
		listRefs: () => listHistoryImageRefs(dataRoot),
	});
	const repushImages = imageStore.register({
		name: "重推原件",
		listRefs: () => listRepushImageRefs(dataRoot),
	});
	return { imageStore, historyImages, repushImages };
}
