import type { ExtensionDocsResponse } from "@bilibili-notify/contract";
import { Btn, ErrorNote, GlassBox, Icon, LoadingBlock, TabBar } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { ApiError, api } from "../../services/api";
import { reasonOf } from "./shared";

/**
 * 拓展自己带的 README / CHANGELOG,画在详情页最底下。
 *
 * **两份分 tab,不摞着** —— 说明动辄一整页,摞着的话更新日志被挤出视野,而更新完点进来
 * 的人要的正是「这版改了啥」。横条不走左侧竖栏:只有两项,左栏要为两个词让掉一整条宽度,
 * 而正文是 markdown、最吃宽度的恰是表格;何况 `SectionNav` 在这个站里是**页面级**分区
 * 导航(还 sticky),摆进详情页底部的一个 section 会读成「这是整页的导航」。
 *
 * tab 进卡头的右槽而不是单架一行:`GlassBox` 的 `title` 是必填的,单架一行会让 tab 说一遍
 * 「说明」、卡标题再说一遍。**只有一份时不出 tab** —— 一个 tab 是噪音,标题直接写那份的名字。
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

type DocTab = "readme" | "changelog";

/** 两份的顺序也在这儿:说明在前 —— 没指定的时候人更可能是来读「这是干嘛的」。 */
const DOC_TABS = ["readme", "changelog"] as const;
const DOC_LABEL: Record<DocTab, string> = { readme: "说明", changelog: "更新日志" };

/** 卡头那枚芯片 15、tab 里那枚 14 —— 两处尺寸不同,所以图标现画不存表。 */
function docIcon(tab: DocTab, size: number): ReactNode {
	return tab === "readme" ? <Icon.feather size={size} /> : <Icon.list size={size} />;
}

export function ExtensionDocs({ extensionId }: { extensionId: string }) {
	const docs = useQuery({
		queryKey: ["extension-docs", extensionId],
		queryFn: () => api.get<ExtensionDocsResponse>(`/api/ext/${extensionId}/docs`),
		retry: false,
	});
	const [picked, setPicked] = useState<DocTab | null>(null);

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
	const text: Partial<Record<DocTab, string>> = {
		readme: docs.data?.readme?.trim() || undefined,
		changelog: docs.data?.changelog?.trim() || undefined,
	};
	const have = DOC_TABS.filter((k) => text[k]);
	if (have.length === 0) return null;

	/*
	 * 🔴 选中项**每次都从「现在有哪些」里挑**,不能只靠 `useState` 的初值 —— 初值在数据
	 * 回来之前就定下了。而且重取之后那一份可能没了(拓展换了个版本、README 被删),停在
	 * 一个空 tab 上就是一整块白,而人什么都没做错。挑不中就退回第一份。
	 */
	const tab: DocTab = picked && text[picked] ? picked : (have[0] as DocTab);
	const tabbed = have.length > 1;

	return (
		<GlassBox
			title={tabbed ? "文档" : DOC_LABEL[tab]}
			icon={docIcon(tab, 15)}
			right={
				tabbed ? (
					<TabBar<DocTab>
						items={have.map((k) => ({ id: k, label: DOC_LABEL[k], icon: docIcon(k, 14) }))}
						value={tab}
						onChange={setPicked}
					/>
				) : null
			}
		>
			<Suspense fallback={<LoadingBlock variant="inset" label="正在读取文档" />}>
				<DocsMarkdown source={text[tab] as string} />
			</Suspense>
		</GlassBox>
	);
}
