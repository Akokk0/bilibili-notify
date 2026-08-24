/**
 * 服务商选择器 —— 标识平铺,点一下就选中。
 *
 * 之所以值得占这么大版面(而不是一个下拉框):选错这一项的后果不是「样式不对」,
 * 而是**思考开关默默不生效**或者**往人家接口上发别家的方言参数**。铺开来选,
 * 主人一眼就能确认选中的是不是自家那一块。
 */

import { AI_PROVIDERS, type AIProviderId } from "@bilibili-notify/internal/constants";
import type { CSSProperties } from "react";
import { PROVIDER_BRANDS, ProviderLogo } from "./provider-logos";

export interface ProviderPickerProps {
	/** 当前选中的那家。`null` = 一个都没选(添加流程里就是这样)。 */
	value: AIProviderId | null;
	onChange: (next: AIProviderId) => void;
	/** 只列这几家。给了就按它过滤 —— 「+ 添加服务商」用来只摆还没添加过的。 */
	only?: readonly AIProviderId[];
}

export function ProviderPicker({ value, onChange, only }: ProviderPickerProps) {
	const shown = only ? AI_PROVIDERS.filter((p) => only.includes(p.id)) : AI_PROVIDERS;
	return (
		<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
			{shown.map((p) => {
				const active = p.id === value;
				const brand = PROVIDER_BRANDS[p.id];
				return (
					<button
						type="button"
						key={p.id}
						onClick={() => onChange(p.id)}
						aria-pressed={active}
						title={p.baseUrlHint}
						// 候选卡走 option。选中态曾经**只买到一半** —— 底与环写在 `style` 里
						// (品牌色),inline 压过一切 author 样式,挂着 option-active 也白挂。
						// 现在 inline 只剩 `--bn-tint` 一个值,涂法在 `bn-tint-ring` 那条
						// @utility 里,皮肤重画得动。品牌色本身仍是逐家不同的行内值 ——
						// 抹成统一 token 等于让卡片说谎(同 Pill / StatsBar 那条)。
						data-bn={active ? "option option-active" : "option"}
						className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 transition ${
							active
								? "border-transparent bn-tint-ring"
								: "border-bn-border bg-bn-surface-muted hover:bg-bn-surface-strong"
						}`}
						// 顺带清掉两个**从来没渲染过**的类:选中档原本还带着 `shadow-sm ring-2`,
						// 而 inline 的 boxShadow 把整条合成影覆盖掉了,那两个类一天都没生效。
						style={{ "--bn-tint": brand.color } as CSSProperties}
					>
						<ProviderLogo id={p.id} />
						<span
							className={`text-bn-xs font-semibold ${active ? "" : "text-bn-text-tertiary"}`}
							style={active ? { color: brand.color } : undefined}
						>
							{p.label}
						</span>
					</button>
				);
			})}
		</div>
	);
}
