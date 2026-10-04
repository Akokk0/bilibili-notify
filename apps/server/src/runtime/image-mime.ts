/**
 * 站内上传图片的 mime ↔ 扩展名对照,**唯一一份**。
 *
 * 站内上传路(卡片背景图 / 皮肤包资产)收的是同一批格式、同一套口径,
 * 各摆一份表的话,加一种格式要改几处 —— 漏掉的那处的症状是「这里传得进去、
 * 那里回 404 或 application/octet-stream」。聊天附件不在其内:它们存进图库,
 * 格式表在 `images/image-store.ts`(按嗅探定格式,不看声明)。
 *
 * **SVG 刻意不在表里**:它能带脚本,而这些图会在 dashboard 里直接渲染。
 */

/** 上传时 mime → 落盘扩展名。名字不信上传来的文件名(不可信输入,要拼进磁盘路径)。 */
export const MIME_TO_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
};

/**
 * 回读时扩展名 → content-type。
 *
 * `gif` **只在这一侧**:站内上传路都不收它(所以不在 `MIME_TO_EXT` 里),但卡片皮肤包
 * 里可以带(`CARD_SKIN_IMAGE_RE` 认它)—— 回读那口查不到表就发 `application/octet-stream`,
 * 而浏览器不会拿它当图画。
 */
export const EXT_TO_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
};

/**
 * 站内上传**收**的后缀 → content-type,喂给资产存储(`createAssetStore`)的 `formats`。
 *
 * 从上面两张表派生,不另摆一份:上传收哪些 mime 由 `MIME_TO_EXT` 定,回读发什么 content-type
 * 由 `EXT_TO_MIME` 定。这里取「回读表里、mime 也在上传表里」的后缀 —— png / jpg / jpeg / webp。
 * `gif` 只在回读侧(皮肤包能带、站内上传不收),被这一道筛掉;SVG 两边都没有。
 */
export const UPLOAD_EXT_TO_MIME: Readonly<Record<string, string>> = Object.fromEntries(
	Object.entries(EXT_TO_MIME).filter(([, mime]) => Object.hasOwn(MIME_TO_EXT, mime)),
);
