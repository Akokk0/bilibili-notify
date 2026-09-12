import type { ExtensionDocsResponse } from "@bilibili-notify/contract";
import { GlassBox, Icon, LoadingBlock } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { lazy, type ReactNode, Suspense } from "react";
import { UNTRUSTED_MARKDOWN_COMPONENTS } from "../../components/untrusted-markdown";
import { api } from "../../services/api";

/**
 * 拓展自己带的 README / CHANGELOG,画在详情页最底下。
 *
 * **谁有画谁,两份都没有整块不画** —— 空盒子比没有更难看,而且会让人以为是加载坏了。
 * 第三方拓展不写 README 是它的自由。
 *
 * 内容是**打包的人写的**,所以走 {@link UNTRUSTED_MARKDOWN_COMPONENTS} 那副受限渲染,
 * 不是站内文档那副(链接只认 http/https、裸 HTML 当字面文本、图片必须绝对 https)。
 *
 * 🔴 `react-markdown` 走 `lazy()`:那一坨约 153KB,静态可达就进初始包,站里所有 `lazy()`
 * 一起作废(`__tests__/markdown-chunk.test.ts` 从入口爬图钉着这件事)。
 */

const ReactMarkdown = lazy(() => import("react-markdown"));

function DocBox({ title, icon, text }: { title: string; icon: ReactNode; text: string }) {
	return (
		<GlassBox title={title} icon={icon}>
			<Suspense fallback={<LoadingBlock variant="inset" label="正在读取说明" />}>
				<ReactMarkdown components={UNTRUSTED_MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
			</Suspense>
		</GlassBox>
	);
}

export function ExtensionDocs({ extensionId }: { extensionId: string }) {
	const docs = useQuery({
		queryKey: ["extension-docs", extensionId],
		queryFn: () => api.get<ExtensionDocsResponse>(`/api/ext/${extensionId}/docs`),
		retry: false,
	});

	// `trim()`:只有空白的一份等于没有 —— 画一个空盒子出来只会让人以为坏了。
	const readme = docs.data?.readme?.trim();
	const changelog = docs.data?.changelog?.trim();
	if (!readme && !changelog) return null;

	return (
		<>
			{readme ? <DocBox title="说明" icon={<Icon.feather size={15} />} text={readme} /> : null}
			{changelog ? (
				<DocBox title="更新日志" icon={<Icon.list size={15} />} text={changelog} />
			) : null}
		</>
	);
}
