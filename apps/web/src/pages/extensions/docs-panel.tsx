import type { ExtensionDocsResponse } from "@bilibili-notify/contract";
import { Btn, ErrorNote, GlassBox, Icon, LoadingBlock } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { lazy, type ReactNode, Suspense } from "react";
import { ApiError, api } from "../../services/api";
import { reasonOf } from "./shared";

/**
 * 拓展自己带的 README / CHANGELOG。
 *
 * **它们是详情页的两档 tab,不是摞在配置底下的两张卡** —— 说明动辄一整页,摞着的话配置区
 * 被一堵正文压着,而更新日志被挤出视野;偏偏更新完点进来的人要的正是「这版改了啥」。
 * 所以这个文件不自己管「现在看哪一份」:它只回答「有哪几份、那一份的正文是什么」,
 * 谁被选中由页面统一管(配置也是一档,归它一起排)。
 *
 * 内容是**打包的人写的**,所以走 `UNTRUSTED_MARKDOWN_COMPONENTS` 那副受限渲染,不是站内
 * 文档那副(链接只认绝对 http/https、裸 HTML 当字面文本、图片必须绝对 https)。
 *
 * 🔴 渲染那一坨(`react-markdown` + `remark-gfm`,约 153KB)走 `lazy()` 进来:静态可达就
 * 进初始包,站里所有 `lazy()` 一起作废(`__tests__/markdown-chunk.test.ts` 从入口爬图
 * 钉着这件事)。持有点是 `docs-markdown.tsx`,它在那条守卫的 `HEAVY_HOLDERS` 里。
 */

const DocsMarkdown = lazy(() => import("./docs-markdown"));

export type ExtensionDocKind = "readme" | "changelog";

/** 顺序也在这儿:说明在前 —— 没指定的时候人更可能是来读「这是干嘛的」。 */
const DOC_KINDS = ["readme", "changelog"] as const;
export const EXTENSION_DOC_LABEL: Record<ExtensionDocKind, string> = {
	readme: "说明",
	changelog: "更新日志",
};

/** 卡头那枚芯片 15、tab 里那枚 14 —— 两处尺寸不同,所以现画不存表。 */
export function extensionDocIcon(kind: ExtensionDocKind, size: number): ReactNode {
	return kind === "readme" ? <Icon.feather size={size} /> : <Icon.list size={size} />;
}

/** 读挂了那一档:一句原话 + 一次重试。404 不进这里(见下)。 */
export interface ExtensionDocsFailure {
	reason: string;
	retry: () => void;
	busy: boolean;
}

export interface ExtensionDocsView {
	/** 真有正文的那几份,按上面的顺序。空白的一份等于没有。 */
	kinds: ExtensionDocKind[];
	text: Partial<Record<ExtensionDocKind, string>>;
	failure: ExtensionDocsFailure | null;
}

/**
 * 问一个装着的拓展要它的两份文档。
 *
 * 🔴 **读不到要说出来。** 服务端在拆包那一刻就答过「这个包带了 README」,装完那句话据此
 * 挂了一颗「看看说明」—— 人点进来却什么都没有的话,得到的结论是「说好有说明的,结果
 * 没有」,而真相可能只是这一刻服务端在重启。仓里的规矩:失败的原因不许吞。
 *
 * 404 是**例外,它不是失败**:老服务端压根没有这条路由(应用内自更新那几秒面板可能比
 * 服务端新),或者这个拓展刚被删掉。两种都该安静。
 */
export function useExtensionDocs(extensionId: string): ExtensionDocsView {
	const docs = useQuery({
		queryKey: ["extension-docs", extensionId],
		queryFn: () => api.get<ExtensionDocsResponse>(`/api/ext/${extensionId}/docs`),
		retry: false,
	});

	// `trim()`:只有空白的一份等于没有 —— 摆一档点进去是空白,比不摆更糟。
	const text: Partial<Record<ExtensionDocKind, string>> = {
		readme: docs.data?.readme?.trim() || undefined,
		changelog: docs.data?.changelog?.trim() || undefined,
	};
	const quiet = !docs.isError || (docs.error instanceof ApiError && docs.error.status === 404);
	return {
		kinds: DOC_KINDS.filter((k) => text[k]),
		text,
		failure: quiet
			? null
			: { reason: reasonOf(docs.error), retry: () => docs.refetch(), busy: docs.isFetching },
	};
}

/** 那句读不到 —— 摆在 tab 条下面,哪一档都看得见:它说的是整个拓展的文档读不到。 */
export function ExtensionDocsFailureNote({ failure }: { failure: ExtensionDocsFailure }) {
	return (
		<ErrorNote size="sm" className="flex flex-wrap items-center gap-x-2 gap-y-1">
			<span>读不到这个拓展的说明:{failure.reason}</span>
			<Btn variant="outline" size="sm" disabled={failure.busy} onClick={failure.retry}>
				重试
			</Btn>
		</ErrorNote>
	);
}

/** 一份文档一张卡。选哪一份不归它管。 */
export function ExtensionDocPane({ kind, text }: { kind: ExtensionDocKind; text: string }) {
	return (
		<GlassBox title={EXTENSION_DOC_LABEL[kind]} icon={extensionDocIcon(kind, 15)}>
			<Suspense fallback={<LoadingBlock variant="inset" label="正在读取文档" />}>
				<DocsMarkdown source={text} />
			</Suspense>
		</GlassBox>
	);
}
