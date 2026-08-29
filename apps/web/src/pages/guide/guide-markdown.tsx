import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DOC_MARKDOWN_COMPONENTS } from "../../components/doc-markdown";

/**
 * 新手指引章节的 Markdown 渲染 —— 内容住 content/*.md(`?raw` 随 bundle),
 * 改文案不碰代码。排版与更新日志同一副(DOC_MARKDOWN_COMPONENTS),指引只
 * 多一层 GFM(总览的选型表)。
 */
export function GuideMarkdown({ source }: { source: string }) {
	return (
		<ReactMarkdown remarkPlugins={[remarkGfm]} components={DOC_MARKDOWN_COMPONENTS}>
			{source}
		</ReactMarkdown>
	);
}
