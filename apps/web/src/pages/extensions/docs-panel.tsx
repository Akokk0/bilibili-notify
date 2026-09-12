import type { ExtensionDocsResponse } from "@bilibili-notify/contract";
import { Btn, ErrorNote, GlassBox, Icon, LoadingBlock } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { lazy, type ReactNode, Suspense } from "react";
import { ApiError, api } from "../../services/api";
import { reasonOf } from "./shared";

/**
 * 拓展自己带的 README / CHANGELOG,画在详情页最底下。
 *
 * **谁有画谁,两份都没有整块不画** —— 空盒子比没有更难看,而且会让人以为是加载坏了。
 * 第三方拓展不写 README 是它的自由。
 *
 * 内容是**打包的人写的**,所以走 `UNTRUSTED_MARKDOWN_COMPONENTS` 那副受限渲染,不是站内
 * 文档那副(链接只认绝对 http/https、裸 HTML 当字面文本、图片必须绝对 https)。
 *
 * 🔴 渲染那一坨(`react-markdown` + `remark-gfm`,约 153KB)走 `lazy()` 进来:静态可达就
 * 进初始包,站里所有 `lazy()` 一起作废(`__tests__/markdown-chunk.test.ts` 从入口爬图
 * 钉着这件事)。持有点是 `docs-markdown.tsx`,它在那条守卫的 `HEAVY_HOLDERS` 里。
 */

const DocsMarkdown = lazy(() => import("./docs-markdown"));

function DocBox({ title, icon, text }: { title: string; icon: ReactNode; text: string }) {
	return (
		<GlassBox title={title} icon={icon}>
			<DocsMarkdown source={text} />
		</GlassBox>
	);
}

export function ExtensionDocs({ extensionId }: { extensionId: string }) {
	const docs = useQuery({
		queryKey: ["extension-docs", extensionId],
		queryFn: () => api.get<ExtensionDocsResponse>(`/api/ext/${extensionId}/docs`),
		retry: false,
	});

	/*
	 * 🔴 **读不到就说出来,别整块消失。** 服务端在拆包那一刻就答过「这个包带了 README」,
	 * 装完那句话据此挂了一颗「看看说明」—— 人点进来却什么都没有的话,得到的结论是
	 * 「说好有说明的,结果没有」,而真相可能只是这一刻服务端在重启。仓里的规矩:失败的
	 * 原因不许吞,更不许连那句话都不说。
	 *
	 * 404 是**例外,它不是失败**:老服务端压根没有这条路由(应用内自更新那几秒面板可能
	 * 比服务端新),或者这个拓展刚被删掉。两种都该安静地整块不画。
	 */
	if (docs.isError) {
		if (docs.error instanceof ApiError && docs.error.status === 404) return null;
		return (
			<ErrorNote size="sm" className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span>读不到这个拓展的说明:{reasonOf(docs.error)}</span>
				<Btn variant="outline" size="sm" disabled={docs.isFetching} onClick={() => docs.refetch()}>
					重试
				</Btn>
			</ErrorNote>
		);
	}

	// `trim()`:只有空白的一份等于没有 —— 画一个空盒子出来只会让人以为坏了。
	const readme = docs.data?.readme?.trim();
	const changelog = docs.data?.changelog?.trim();
	if (!readme && !changelog) return null;

	return (
		// 一个 Suspense 罩住两块:它们共用同一个懒块,分开罩只会同时转两个圈。
		<Suspense fallback={<LoadingBlock variant="inset" label="正在读取文档" />}>
			{readme ? <DocBox title="说明" icon={<Icon.feather size={15} />} text={readme} /> : null}
			{changelog ? (
				<DocBox title="更新日志" icon={<Icon.list size={15} />} text={changelog} />
			) : null}
		</Suspense>
	);
}
