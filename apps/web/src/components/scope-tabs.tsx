/**
 * 作用域切换条 —— 「全局 / 全部 UP」+ 已定制 UP 的 tab + 「添加 UP」下拉。
 *
 * 纯展示组件,全 prop 驱动(scope / onChange / tabSubs / availableSubs /
 * onAddSub / onRemoveSub / overridesCountFor),不绑定任何具体的覆盖语义 ——
 * 由调用方(Rules 全量 overrides / Cards 仅卡片 overrides)各自计算 tab 列表与
 * 计数,从而在同一 Subscription.overrides 上各管各的切片。
 */

// 不走 pages/up/helpers —— 组件层反向 import 页面层是圈套;色板直取 internal 正身。
import { colorFromUid } from "@bilibili-notify/internal/constants";
import {
	ADD_LANGUAGE,
	Avatar,
	EmptyNote,
	Icon,
	IconButton,
	MenuItem,
	Pill,
	PopoverShell,
	SELECTED_LANGUAGE,
	TabBarShell,
	TabButton,
	useDismiss,
} from "@bilibili-notify/ui";
import { useRef, useState } from "react";
import type { Subscription } from "../types/domain";
import { displayName } from "../utils/up-display";

/** "__global" = 全局默认;其余 = subscription.id。 */
export type Scope = "__global" | string;

export interface ScopeTabsProps {
	scope: Scope;
	onChange: (next: Scope) => void;
	tabSubs: Subscription[];
	availableSubs: Subscription[]; // candidates for "添加 UP" dropdown
	onAddSub: (id: string) => void;
	onRemoveSub: (id: string) => void;
	overridesCountFor: (sub: Subscription) => number;
	/** 自定义提示语(右侧)。默认走 Rules 文案;Cards 传卡片专属文案。 */
	globalHint?: string;
	perUpHint?: (sub: Subscription | undefined) => React.ReactNode;
}

export function ScopeTabs({
	scope,
	onChange,
	tabSubs,
	availableSubs,
	onAddSub,
	onRemoveSub,
	overridesCountFor,
	globalHint,
	perUpHint,
}: ScopeTabsProps) {
	const [adding, setAdding] = useState(false);
	const dropdownRef = useRef<HTMLDivElement | null>(null);

	useDismiss(dropdownRef, () => setAdding(false), { enabled: adding });

	const isGlobal = scope === "__global";

	return (
		<TabBarShell>
			{/* 全局。与 AI 页那条 tab 用的是同一个按钮原语 —— 观感只有一处定义,改不散。 */}
			<TabButton
				active={isGlobal}
				onClick={() => onChange("__global")}
				icon={<Icon.bell size={14} />}
				code="default"
			>
				全局 / 全部 UP
			</TabButton>

			{tabSubs.length > 0 ? <span className="mx-0.5 h-5.5 w-px bg-bn-border" /> : null}

			{/* per-UP tabs (仅显示已定制 + 客户端临时添加的) */}
			{tabSubs.map((sub) => {
				const active = scope === sub.id;
				const color = colorFromUid(sub.uid);
				const count = overridesCountFor(sub);
				return (
					<div
						key={sub.id}
						// 挂点与同条 tab 条上的 TabButton 同口径(tab 家族,曾是 btn)——此前
						// 「全局 / 全部 UP」有挂点、紧挨着的 per-UP tab 一个都没有,皮肤改样式
						// 时一条 tab 里第一颗变了、后面几颗没变,并排摆着。观感上两者仍有差
						// (实底 vs 描边),那是另一条账。
						data-bn={active ? "tab tab-active" : "tab"}
						className={`flex items-center gap-1.5 rounded-lg border py-1.5 pl-3 pr-1.5 text-bn-sm font-bold transition ${
							active
								? "border-bn-pink/25 bg-bn-surface text-bn-pink shadow-bn-card"
								: "border-transparent text-bn-text-tertiary hover:text-bn-text-primary"
						}`}
					>
						<button
							type="button"
							onClick={() => onChange(sub.id)}
							className="flex items-center gap-1.5"
						>
							<Avatar
								name={displayName(sub)}
								color={color}
								size={18}
								url={sub.cachedProfile?.avatar}
							/>
							<span className="max-w-35 truncate" title={displayName(sub)}>
								{displayName(sub)}
							</span>
							{count > 0 ? (
								<Pill
									color={active ? "var(--color-bn-pink)" : "var(--color-bn-inactive)"}
									subtle
									size="sm"
								>
									{count}
								</Pill>
							) : null}
						</button>
						{/* 曾是站里最后一颗手写的图标钮(收编 23 处后的漏网):active 时静态粉字
						    是收编前的旧作派,IconButton 的既定哲学是「平时安静、粉只在指上去时
						    出现」(tone 只管 hover 语义)—— 迁移时一并归正。 */}
						<IconButton
							icon={<Icon.close size={11} />}
							label={`移除 ${displayName(sub)} 的个性化配置`}
							size="xs"
							tone={active ? "accent" : "neutral"}
							onClick={(e) => {
								e.stopPropagation();
								onRemoveSub(sub.id);
							}}
						/>
					</div>
				);
			})}

			{/* 添加 UP 按钮 + 下拉。虚线=空位语汇,挂专词 `add-slot` 而非 `btn`(皮肤的
			    按钮实底会把「还能再加一个」画成真按钮);闲置观感整句吃 ADD_LANGUAGE ——
			    此前 hover 只加深文字,与家族的「粉描边+粉纱」不是一路(2026-08-30 主人
			    点名统一);展开态说全站统一的选中语汇 —— 曾是自配的 pink/40 + /6 纱。 */}
			<div className="relative" ref={dropdownRef}>
				<button
					type="button"
					onClick={() => setAdding((v) => !v)}
					title="从订阅列表添加 UP 主的个性化配置"
					data-bn="add-slot"
					className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-bn-sm font-semibold ${
						adding ? `${SELECTED_LANGUAGE} transition` : ADD_LANGUAGE
					}`}
				>
					<Icon.plus size={13} />
					添加 UP
				</button>
				{adding ? (
					<PopoverShell layer="nav" variant="flush" className="min-w-60">
						<div className="border-b border-bn-border-subtle px-3 pb-1.5 pt-2 text-bn-xs font-bold uppercase tracking-wider text-bn-text-tertiary">
							选择要单独定制的 UP 主
						</div>
						{availableSubs.length === 0 ? (
							<EmptyNote size="sm" className="m-2">
								所有已订阅的 UP 主都已添加
							</EmptyNote>
						) : (
							<div className="max-h-72 overflow-y-auto py-1">
								{availableSubs.map((sub) => {
									const color = colorFromUid(sub.uid);
									return (
										<MenuItem
											key={sub.id}
											onClick={() => {
												onAddSub(sub.id);
												setAdding(false);
											}}
										>
											<Avatar
												name={displayName(sub)}
												color={color}
												size={28}
												url={sub.cachedProfile?.avatar}
											/>
											<div className="min-w-0 flex-1">
												<div className="truncate text-bn-sm font-bold text-bn-text-primary">
													{displayName(sub)}
												</div>
												<div className="text-bn-2xs text-bn-text-tertiary tabular-nums">
													UID {sub.uid}
												</div>
											</div>
											{sub.state.liveStatus === "live" ? (
												<Pill color="var(--color-bn-pink)" subtle size="sm">
													播
												</Pill>
											) : null}
										</MenuItem>
									);
								})}
							</div>
						)}
						<button
							type="button"
							onClick={() => setAdding(false)}
							className="block w-full border-t border-bn-border-subtle py-2 text-center text-bn-xs text-bn-text-tertiary hover:text-bn-text-primary"
						>
							取消
						</button>
					</PopoverShell>
				) : null}
			</div>

			<div className="flex-1" />
			<div className="px-2 text-bn-xs text-bn-text-tertiary">
				{isGlobal ? (
					(globalHint ?? "此处为全部 UP 默认设置")
				) : perUpHint ? (
					perUpHint(tabSubs.find((s) => s.id === scope))
				) : (
					<>
						仅作用于 <b className="text-bn-pink">{tabSubs.find((s) => s.id === scope)?.uid}</b>
						,未开启的项继承全局
					</>
				)}
			</div>
		</TabBarShell>
	);
}
