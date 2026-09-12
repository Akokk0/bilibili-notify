import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { UNTRUSTED_MARKDOWN_COMPONENTS } from "../../components/untrusted-markdown";

/**
 * 画一份**第三方拓展**自带的文档。
 *
 * 🔴 **这个文件是 `react-markdown` 的持有点**(与 `pages/guide/guide-markdown.tsx` 同一个
 * 套路),所以它必须一直待在懒边界后面 —— `docs-panel.tsx` 用 `lazy()` 进来。那一坨约
 * 153KB,静态可达就进初始包,站里所有 `lazy()` 一起作废。新增持有点要一并写进
 * `__tests__/markdown-chunk.test.ts` 的 `HEAVY_HOLDERS`,那条守卫两头都钉着。
 *
 * GFM 是给第三方用的,不是可有可无:表格(能力对照、平台支持)是 README 里最常见的结构,
 * 不挂的话逐行画成字面的 `| a | b |`,而 `DOC_MARKDOWN_COMPONENTS` 里 `table` / `th` /
 * `td` 那三格也就成了永远不可达的死代码。
 */
export default function DocsMarkdown({ source }: { source: string }) {
	return (
		<ReactMarkdown remarkPlugins={[remarkGfm]} components={UNTRUSTED_MARKDOWN_COMPONENTS}>
			{source}
		</ReactMarkdown>
	);
}
