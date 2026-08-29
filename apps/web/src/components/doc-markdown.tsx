import type { Components } from "react-markdown";
import { Link } from "react-router-dom";
import { externalLinkClick } from "../utils/externalLink";

/**
 * 文档类 Markdown 的统一排版 —— 更新日志(apps/CHANGELOG.md)与新手指引
 * (pages/guide/content/*.md)共用同一副组件映射,两处观感一致(定案:指引
 * 不再单独手搓一套渲染)。本模块只导出映射,不 import react-markdown 运行时,
 * 消费方自决 eager / lazy。
 *
 * 方言只有一条:以 `/` 开头的站内链接渲染成 react-router 的 <Link>(普通
 * <a> 会整页刷新),其余 href 一律外链(新窗口 + externalLinkClick)。内容
 * 都是仓库内静态文件、非用户输入,不需要 AI 聊天那套 safeHref 白名单。
 */
export const DOC_MARKDOWN_COMPONENTS: Components = {
	h1: ({ children }) => (
		<h1 className="mt-0 mb-4 border-b border-bn-border-subtle pb-3 text-bn-hero font-extrabold tracking-tight text-bn-text-primary">
			{children}
		</h1>
	),
	h2: ({ children }) => (
		<h2 className="mt-7 mb-3 text-bn-xl font-extrabold tracking-tight text-bn-text-primary">
			{children}
		</h2>
	),
	h3: ({ children }) => (
		<h3 className="mt-5 mb-2 text-bn-md font-bold uppercase tracking-wide text-bn-pink">
			{children}
		</h3>
	),
	p: ({ children }) => (
		<p className="my-2 text-bn-base leading-7 text-bn-text-secondary">{children}</p>
	),
	ul: ({ children }) => (
		<ul className="my-2 list-disc space-y-1.5 pl-5 text-bn-base text-bn-text-secondary">
			{children}
		</ul>
	),
	ol: ({ children }) => (
		<ol className="my-2 list-decimal space-y-1.5 pl-5 text-bn-base text-bn-text-secondary">
			{children}
		</ol>
	),
	// 宽松列表里 remark 会给列表项包一层 p,压掉它的段间距
	li: ({ children }) => <li className="leading-7 marker:text-bn-pink/70 [&>p]:my-0">{children}</li>,
	blockquote: ({ children }) => (
		<blockquote className="my-3 border-l-2 border-bn-pink/40 pl-3 text-bn-base leading-7 text-bn-text-secondary [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
			{children}
		</blockquote>
	),
	code: ({ node: _node, className, children, ...props }) => (
		<code
			className={`rounded-md bg-bn-code-bg px-1.5 py-0.5 font-mono text-bn-sm text-bn-text-primary ${className ?? ""}`}
			{...props}
		>
			{children}
		</code>
	),
	/** 代码/配置块。暗面走 console token;行内码那档底色与内边距在块里压掉。 */
	pre: ({ children }) => (
		<pre className="my-3 overflow-x-auto rounded-bn-sm border border-bn-border-subtle bg-bn-console-bg p-3 text-bn-sm leading-relaxed text-bn-console-text [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit">
			{children}
		</pre>
	),
	a: ({ children, href }) => {
		if (href?.startsWith("/")) {
			return (
				<Link to={href} className="font-semibold text-bn-pink underline-offset-2 hover:underline">
					{children}
				</Link>
			);
		}
		return (
			<a
				href={href}
				target="_blank"
				rel="noreferrer"
				onClick={externalLinkClick(href)}
				className="font-semibold text-bn-pink underline-offset-2 hover:underline"
			>
				{children}
			</a>
		);
	},
	/** GFM 表格(指引的选型表)。表格必须能横滚,别让页面横向溢出。 */
	table: ({ children }) => (
		<div className="my-3 overflow-x-auto">
			<table className="w-full min-w-120 border-collapse text-bn-base">{children}</table>
		</div>
	),
	th: ({ children }) => (
		<th className="border-b border-bn-border px-2.5 py-1.5 text-left font-semibold text-bn-text-primary">
			{children}
		</th>
	),
	td: ({ children }) => (
		<td className="border-b border-bn-border-subtle px-2.5 py-1.5 align-top leading-7 text-bn-text-secondary">
			{children}
		</td>
	),
};
