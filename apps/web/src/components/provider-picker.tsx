/**
 * 服务商选择器 —— 标识平铺,点一下就选中。
 *
 * 之所以值得占这么大版面(而不是一个下拉框):选错这一项的后果不是「样式不对」,
 * 而是**思考开关默默不生效**或者**往人家接口上发别家的方言参数**。铺开来选,
 * 主人一眼就能确认选中的是不是自家那一块。
 */

import { AI_PROVIDERS, type AIProviderId } from "@bilibili-notify/internal/constants";
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
						data-bn="btn"
						className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 transition ${
							active
								? "border-transparent shadow-sm ring-2"
								: "border-bn-border bg-bn-surface-muted hover:bg-bn-surface-strong"
						}`}
						style={
							active
								? {
										backgroundColor: `color-mix(in srgb, ${brand.color} 10%, transparent)`,
										boxShadow: `0 0 0 2px ${brand.color}`,
									}
								: undefined
						}
					>
						<ProviderLogo id={p.id} />
						<span
							className={`text-[11.5px] font-semibold ${active ? "" : "text-bn-text-tertiary"}`}
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
