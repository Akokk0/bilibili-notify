import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * 女仆回复的 Markdown 渲染。
 *
 * ## 为什么要当心
 *
 * 回复里夹着 B 站的文本 —— 动态正文、UP 昵称、直播间标题都经工具结果进模型上下文,
 * 模型会照抄进回复(见 `packages/ai/src/tools.ts`)。也就是说这部分内容**攻击者
 * 可控**。原来一律纯文本,怎么写都无害;按 Markdown 渲染之后就多了三个出口,各自
 * 的处置不同:
 *
 * - **图片:一张都不渲染。**它是三者里唯一「零交互」的 —— 主人只要打开对话,浏览器
 *   就会去请求那个地址,泄露 IP 与 referer,不需要点任何东西。降级成显示 alt 文字。
 * - **链接:放行,但只认 http/https**(见 {@link safeHref}),并强制新窗口 +
 *   `rel="noopener noreferrer"`。
 * - **裸 HTML:交给 react-markdown 的默认行为**(当字面文本)。关键是**绝不引
 *   `rehype-raw`** —— 那个插件会把 `<img onerror=…>` 变成真节点。有测试盯着这条。
 *
 * ## 为什么不做语法高亮
 *
 * 高亮要拖进 shiki / highlight.js 那一级的依赖,而女仆聊天里出现代码的概率极低。
 * 代码块只给等宽字体 + 底色 + 横向滚动。
 */

/**
 * 放行的协议。其余(`javascript:` / `data:` / `vbscript:` / `mailto:` …)一律掐掉。
 *
 * 白名单而不是黑名单:黑名单要穷举所有能跑脚本的协议,漏一个就是个洞。这里连
 * `mailto:` 也不给 —— 这个场景下它几乎不会出现,而每多一个放行项都是一条要单独
 * 想清楚的路。
 */
const SAFE_PROTOCOLS = ["http:", "https:"];

/**
 * 只让安全协议落成可点的 href。
 *
 * 拿 `URL` 真解析而不是用正则筛前缀:`java\nscript:` 这类带控制字符 / 大小写混写 /
 * 百分号编码的花样能绕过朴素的字符串判断,而浏览器照样认。解析不出来的相对地址
 * 原样放行(它跳不出本站)。
 */
export function safeHref(href: string | undefined): string | undefined {
	if (!href) return undefined;
	let url: URL;
	try {
		url = new URL(href, "https://placeholder.invalid/");
	} catch {
		return undefined; // 连解析都失败 → 不给它 href
	}
	if (!SAFE_PROTOCOLS.includes(url.protocol)) return undefined;
	return href;
}

/**
 * 组件映射。字号 / 行高沿用消息流正文那一档(15px / 1.78),让 Markdown 块混在
 * 纯文本回复里不突兀;强调色一律走 `--bn-chat-accent-*`,不写死颜色 —— 主题色是
 * 主人能换的。
 */
const COMPONENTS: Components = {
	// 段落之间用 margin 而不是容器的 gap:容器还要装列表 / 代码块 / 引用,
	// 各自需要的间距不一样。
	p: ({ children }) => <p className="my-[0.5em] first:mt-0 last:mb-0">{children}</p>,

	// 标题统一降级成「加粗的一行」。h1 的真实字号在 720px 的对话里非常突兀,而
	// 模型用 `#` 往往只是想强调一下小节名,并不是真要一个文档标题。
	...headingsAsBoldLine(),

	strong: ({ children }) => <strong className="font-bold">{children}</strong>,
	em: ({ children }) => <em className="italic">{children}</em>,
	del: ({ children }) => <del className="opacity-60">{children}</del>,

	a: ({ href, children }) => {
		const safe = safeHref(href);
		// 协议不安全 → 退化成纯文字。留一个没有 href 的 <a> 会是个假的可点物件。
		if (!safe) return <>{children}</>;
		return (
			<a
				href={safe}
				target="_blank"
				// noreferrer 与 noopener 一起给:前者顺带不把 dashboard 的地址漏给对方。
				rel="noopener noreferrer"
				className="bn-chat-accent underline decoration-from-font underline-offset-2"
			>
				{children}
			</a>
		);
	},

	// 图片不渲染,只留 alt。见文件头的理由。
	img: ({ alt }) => <span className="text-bn-text-tertiary">{alt || "[图片]"}</span>,

	ul: ({ children }) => (
		<ul className="my-[0.5em] list-disc space-y-[0.2em] pl-[1.4em] first:mt-0 last:mb-0">
			{children}
		</ul>
	),
	ol: ({ children }) => (
		<ol className="my-[0.5em] list-decimal space-y-[0.2em] pl-[1.4em] first:mt-0 last:mb-0">
			{children}
		</ol>
	),
	li: ({ children }) => <li className="marker:text-bn-text-tertiary">{children}</li>,

	blockquote: ({ children }) => (
		<blockquote className="bn-chat-accent-border my-[0.6em] border-l-[3px] pl-3 text-bn-text-secondary first:mt-0 last:mb-0">
			{children}
		</blockquote>
	),

	// 行内码与代码块共用这一个 `code`。react-markdown 只在**块级**时给它挂
	// `language-*` 类,所以靠 `className` 里有没有 `language-` 区分不可靠(没标语言的
	// 围栏也没有那个类)。改从 `pre` 那一侧下手:块级的 code 由 pre 包着,
	// pre 负责滚动与底色,code 只管字体。
	code: ({ children, className }) => (
		<code
			className={`rounded-bn-xs bg-bn-code-bg px-[0.35em] py-[0.1em] font-mono text-[0.88em] ${className ?? ""}`}
		>
			{children}
		</code>
	),
	// 代码块:横向滚动而不是换行 —— 一行长命令折成五行比滚动更难读。
	// 里头那个 code 的底色和内边距要压掉,否则块里再套一层浅底。
	pre: ({ children }) => (
		<pre className="my-[0.6em] overflow-x-auto rounded-lg bg-bn-code-bg p-3 text-bn-base leading-[1.6] first:mt-0 last:mb-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-bn-base">
			{children}
		</pre>
	),

	// 表格自己会撑宽,套一层滚动容器把它关住 —— 否则整页跟着横向滚。
	table: ({ children }) => (
		<div className="my-[0.6em] overflow-x-auto first:mt-0 last:mb-0">
			<table className="w-full border-collapse text-bn-base">{children}</table>
		</div>
	),
	th: ({ children }) => (
		<th className="border border-bn-border px-2 py-1 text-left font-semibold">{children}</th>
	),
	td: ({ children }) => <td className="border border-bn-border px-2 py-1">{children}</td>,

	hr: () => <hr className="my-[0.8em] border-bn-border" />,
};

/** h1~h6 一律画成加粗的一行。六个层级同一个样子 —— 对话里不需要层级感。 */
function headingsAsBoldLine(): Components {
	const line = ({ children }: { children?: ReactNode }) => (
		<p className="my-[0.6em] font-bold first:mt-0 last:mb-0">{children}</p>
	);
	return { h1: line, h2: line, h3: line, h4: line, h5: line, h6: line };
}

/**
 * `remark-gfm` 给删除线 / 表格 / 自动链接;`remark-breaks` 让**单个换行**成为真换行。
 *
 * 后者是必需的而非顺手:严格 Markdown 里单换行只是空白,女仆那种一句一行的短句会被
 * 折成一整坨。数组提到组件外面,免得每次渲染(流式下每来一片都渲染一次)都重建。
 */
const PLUGINS = [remarkGfm, remarkBreaks];

export function ChatMarkdown({ text }: { text: string }) {
	return (
		<ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
			{text}
		</ReactMarkdown>
	);
}
