import type { Components } from "react-markdown";
import { safeHref } from "../utils/safe-href";
import { DOC_MARKDOWN_COMPONENTS } from "./doc-markdown";

/**
 * 渲染**第三方拓展**自带的 README / CHANGELOG。
 *
 * 排版整个借 {@link DOC_MARKDOWN_COMPONENTS}(与更新日志、新手指引同一副,观感一致),
 * 只把**碰得到外部世界的那两格**换掉 —— 因为前提变了:那份明写着「内容都是仓库内静态
 * 文件、非用户输入」,而这里的内容是任何人打进拓展包里的。
 *
 * 两条底线,各有一条测试盯着:
 *
 * - **链接只认绝对的 http / https**。协议白名单交给 `safeHref`(与 AI 聊天同一把尺子),
 *   「必须是绝对地址」是这里额外加的 —— 相对路径脱离了源仓就拼不出来。两种都不给 href、
 *   退成纯文字 —— 留一个没有 href 的 `<a>` 是个假的可点物件。
 * - **绝不引 `rehype-raw`**。裸 HTML 当字面文本。AstrBot 那头开了 `markdown-it` 的
 *   `html: true`,于是需要一长串 DOMPurify 白名单,即便如此也修过两个 README XSS。
 *   不开这扇门,攻击面小一个数量级;代价只是少数 README 的 `<details>` 折叠会退成纯文本。
 *
 * ⚠️ 与 `doc-markdown.tsx` 同一条规矩:**只 `import type`,不 import `react-markdown`
 * 运行时** —— 那一坨约 153KB,静态可达就会进初始包,把站里所有 `lazy()` 变成摆设
 * (`markdown-chunk.test.ts` 从入口爬图钉着这件事)。消费方自己 `lazy()`。
 */

/** 图片要绝对 https:相对路径脱离了仓库上下文,拼不出地址,渲染出来就是个坏图。 */
function absoluteHttps(src: string | undefined): string | undefined {
	if (!src) return undefined;
	try {
		return new URL(src).protocol === "https:" ? src : undefined;
	} catch {
		return undefined; // 相对路径解析不出绝对地址 —— 正是要拦的那一档
	}
}

/**
 * 链接也要**绝对**地址,和图片一把尺子。
 *
 * `safeHref` **刻意**放行相对地址(AI 聊天那条路的前提是「它跳不出本站」),但这里的前提
 * 相反:`[协议](./PROTOCOL.md)` 这种第三方 README 里最常见的写法,那个文件根本不在包里 ——
 * 点下去跳到 `<面板>/extensions/PROTOCOL.md`,界面写着「没有装名叫 PROTOCOL.md 的拓展」,
 * 看起来像 BN 自己坏了。`//evil.com` 那一档顺带也拦住了:长在面板里的钓鱼链接更容易被信。
 *
 * 拦在这一格而不去改那把共用的尺子 —— 变的是前提,不是尺子。协议白名单仍旧交给它。
 */
function absoluteSafeHref(href: string | undefined): string | undefined {
	if (!href) return undefined;
	try {
		new URL(href); // 不给 base 解析不出来 = 相对 / 协议相对,这里拼不出地址
	} catch {
		return undefined;
	}
	return safeHref(href);
}

export const UNTRUSTED_MARKDOWN_COMPONENTS: Components = {
	...DOC_MARKDOWN_COMPONENTS,

	a: ({ href, children }) => {
		const safe = absoluteSafeHref(href);
		if (!safe) return <>{children}</>;
		return (
			<a
				href={safe}
				target="_blank"
				// noreferrer 顺带不把这台 BN 的地址漏给对方 —— 面板常跑在内网。
				rel="noopener noreferrer"
				className="text-bn-pink underline decoration-from-font underline-offset-2"
			>
				{children}
			</a>
		);
	},

	img: ({ src, alt }) => {
		const safe = absoluteHttps(typeof src === "string" ? src : undefined);
		// 相对路径 → 画个占位,别留一张碎图。AstrBot 那头就是直接坏图。
		if (!safe) {
			return <span className="text-bn-text-tertiary text-bn-sm">[{alt || "图片"} —— 见源站]</span>;
		}
		return (
			<img
				src={safe}
				alt={alt || ""}
				loading="lazy"
				// 徽章 / 截图大多挂在第三方图床上,别把这台面板的地址捎过去。
				referrerPolicy="no-referrer"
				className="my-2 max-w-full rounded-bn-sm"
			/>
		);
	},
};
