/**
 * 站内上传图片的 mime ↔ 扩展名对照,**唯一一份**。
 *
 * 三条上传路(卡片背景图 / 聊天附件 / 皮肤包资产)收的是同一批格式、同一套口径,
 * 各摆一份表的话,加一种格式要改三处 —— 漏掉的那处的症状是「这里传得进去、
 * 那里回 404 或 application/octet-stream」。
 *
 * **SVG 刻意不在表里**:它能带脚本,而这些图会在 dashboard 里直接渲染。
 */

/** 上传时 mime → 落盘扩展名。名字不信上传来的文件名(不可信输入,要拼进磁盘路径)。 */
export const MIME_TO_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
};

/** 回读时扩展名 → content-type。 */
export const EXT_TO_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
};
