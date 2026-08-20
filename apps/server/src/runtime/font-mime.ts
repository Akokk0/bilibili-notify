/**
 * 站内上传字体的扩展名 ↔ mime 对照,**唯一一份** —— 与图片那份 `image-mime.ts`
 * 同一个用意:两条上传路(卡片字体图廊 / 皮肤包自带字体)收的是同一批格式,各摆
 * 一份表的话,加一种格式要改两处,漏掉的那处的症状是「这里传得进去、那里回
 * application/octet-stream,浏览器直接不认这份字体」。
 *
 * **与图片那份有一处刻意不同:方向只有「扩展名 → mime」,没有反向表。**
 * 图片的 mime 各家浏览器给得准,所以那边靠 mime 定扩展名(文件名是不可信输入);
 * 字体不然 —— 同一个 .ttf 可能是 `font/ttf`、`application/x-font-ttf`、
 * `application/octet-stream`,甚至空串。照 mime 判会把一堆正常字体拒在门外,所以
 * 字体这边**认后缀**,再由落盘层自己生成安全的文件名(不拿上传的名字拼路径)。
 */

/** 后缀 → mime。RFC 8081 的 `font/*`,Chromium / Firefox / Safari 都认。 */
export const FONT_EXT_TO_MIME: Record<string, string> = {
	woff2: "font/woff2",
	woff: "font/woff",
	ttf: "font/ttf",
	otf: "font/otf",
};

/**
 * 原始文件名 → 后缀;认不出返回 undefined(调用方据此拒收)。
 *
 * 大小写归一:主人从系统字体目录里拖出来的常常是 `.TTF`。
 */
export function fontExtOf(filename: string): string | undefined {
	const ext = filename.toLowerCase().split(".").pop();
	return ext && ext in FONT_EXT_TO_MIME ? ext : undefined;
}
