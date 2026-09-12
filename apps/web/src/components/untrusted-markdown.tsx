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
 * - **链接只认 http / https**(`safeHref`,与 AI 聊天同一把尺子)。不安全的协议不给
 *   href、退成纯文字 —— 留一个没有 href 的 `<a>` 是个假的可点物件。
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

export const UNTRUSTED_MARKDOWN_COMPONENTS: Components = {
	...DOC_MARKDOWN_COMPONENTS,

	a: ({ href, children }) => {
		const safe = safeHref(href);
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
