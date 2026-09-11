import type { ExtensionDTO } from "@bilibili-notify/contract";
import { ErrorNote, Icon, WarnNote } from "@bilibili-notify/ui";
import { type UseMutationResult, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../services/api";
import { EXTENSION_STATE_META } from "./state-meta";

/**
 * 列表页与详情页共用的那几件 —— **两页说的是同一个拓展**,抄两份的下场是同一件事
 * 在两页上长得不一样,而两边都不会报错。
 */

/**
 * 清单里那枚图标 —— **服务端已经过过白名单**(ADR-0012 决策 20 与 `manifest-icon.ts`),
 * 这里只管画。没有 / 没通过的退回灰方章:一个空方块与「这个拓展没给图标」看起来一样,
 * 而后者才是事实。
 */
export function ExtensionIcon({ svg, size = 17 }: { svg?: string; size?: number }) {
	if (!svg) {
		return (
			<span data-bn-ext-icon="fallback" className="flex">
				<Icon.square size={size} />
			</span>
		);
	}
	return (
		<span
			data-bn-ext-icon="manifest"
			className="flex [&>svg]:h-4.5 [&>svg]:w-4.5"
			// 这段 SVG 要吃 currentColor 才能在渐变方块上是白的,`<img src="data:">` 做不到。
			// biome-ignore lint/security/noDangerouslySetInnerHtml: 服务端读清单那一刻就过了白名单(safeExtensionIcon),那是唯一的门
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
}

/** 一段说明文字(卡片正文 / 提示盒里那种):11px、行距 1.65,设计稿上所有段落都是这一档。 */
export const PARAGRAPH_CLS = "text-bn-xs leading-[1.65] text-bn-text-secondary text-pretty";

/**
 * 「为什么没跑起来」。分红黄两档不是口味:清单坏了 / 加载炸了要主人去动手,而连败自动
 * 停用与版本不合是「换一版就好」,同一个红盒会让前者被当成后者放着不管。
 */
export function ExtensionStateDetail({ ext }: { ext: ExtensionDTO }) {
	if (!ext.detail) return null;
	const { severity } = EXTENSION_STATE_META[ext.state];
	if (severity === "err") return <ErrorNote size="sm">{ext.detail}</ErrorNote>;
	if (severity === "warn") return <WarnNote size="sm">{ext.detail}</WarnNote>;
	return null;
}

/** 「为什么没成」那句话。服务端的三种错误体已由 `ApiError` 归一成 message。 */
export function reasonOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * 拨那个开关。
 *
 * 🔴 补丁**只带自己那一格**:配置是 JSON Merge Patch,整张 `extensions` 表发出去的话,
 * 别处刚拨的开关会被这一发按回旧值 —— 两边都不报错。两页共用这一个,正是怕哪天只改了
 * 其中一处。
 */
export function useExtensionToggle() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (next: { id: string; enabled: boolean }) =>
			api.patch("/api/globals", { extensions: { [next.id]: { enabled: next.enabled } } }),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ["extensions"] });
			void qc.invalidateQueries({ queryKey: ["globals"] });
		},
	});
}

/**
 * 拨不动的时候说一句。
 *
 * 🔴 开关的值来自服务端那份表,失败时它会**自己弹回原位** —— 那是唯一的反馈,而它与
 * 「我点歪了」长得一模一样。原因就在那条响应里躺着(只读盘 / 401 / 配置被别处锁了),
 * 不说等于让主人对着黑盒反复按。两页共用这一句,免得哪天只有一页说得出话。
 */
export function ExtensionToggleError({
	toggle,
}: {
	toggle: UseMutationResult<unknown, Error, { id: string; enabled: boolean }, unknown>;
}) {
	if (!toggle.isError) return null;
	return <ErrorNote size="sm">这个开关没拨动:{reasonOf(toggle.error)}</ErrorNote>;
}
