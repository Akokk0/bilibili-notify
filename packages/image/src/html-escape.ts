/**
 * 包内**唯一**的 HTML 转义(2026-09-20 合的)。
 *
 * 从前这个包里躺着三份互不相同的近亲:`skin/render-skin.tsx` 的(`& < > " '`)、
 * `rich-text.tsx` 的(`& < > "`)、`blocks/sc.tsx` 的(`& < >` 再把换行换成 `<br>`)。
 * 三份的产物全都喂 `innerHTML` 或属性位,而**漏一个字符的后果不对称** —— 少转 `<`
 * 是注入,少转 `"` 是属性提前闭合;多转一个只是 HTML 源码里多几个字节,画出来的像素
 * 一模一样。所以合并时取的是**并集**,不是哪一份的原样。
 *
 * 转哪几个字符由 `__tests__/html-escape.test.ts` 逐字符钉着 —— 「哪份漏了什么」从此是
 * 一条测试答得上来的问题,不用再挨个读实现。
 */

/** 文本与属性值统一的 HTML 转义(属性位置也用它,所以引号必须转)。 */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * 转义 + 保留换行。SC 卡的留言是 B 站弹幕来的原文,要经 `innerHTML` 才留得住换行
 * (JSX 文本节点会把 `\n` 画成一个空格)—— 换行是**唯一**允许活下来的那点结构,
 * 别的一律先转义掉再换。
 */
export function escapeHtmlWithBreaks(s: string): string {
	return escapeHtml(s).replace(/\n/g, "<br>");
}
