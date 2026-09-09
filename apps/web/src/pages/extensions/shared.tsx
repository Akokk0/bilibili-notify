import type { ExtensionDTO } from "@bilibili-notify/contract";
import { EXTENSION_ROOT_LABEL } from "@bilibili-notify/contract";
import { Icon } from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../services/api";

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

/** 有图标的一张跟着品牌色走;没有的连方块一起转灰 —— 灰是「关于它我们只知道这么多」。 */
export function extensionAccent(ext: ExtensionDTO): string {
	return ext.icon ? "var(--color-bn-pink)" : "var(--color-bn-inactive)";
}

/** 这一份是从哪儿扫出来的。盘上有同名两份时,只有全路径答得了「我改的是不是它」。 */
export function ExtensionRootLine({ ext }: { ext: ExtensionDTO }) {
	return (
		<div className="flex items-center gap-1.5 text-bn-xs text-bn-text-tertiary">
			<Icon.folder size={12} />
			<span className="shrink-0">{EXTENSION_ROOT_LABEL[ext.root.kind]} ·</span>
			<span className="truncate font-mono">{ext.root.dir}</span>
		</div>
	);
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
