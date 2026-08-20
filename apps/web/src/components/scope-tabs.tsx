/**
 * 作用域切换条 —— 「全局 / 全部 UP」+ 已定制 UP 的 tab + 「添加 UP」下拉。
 *
 * 纯展示组件,全 prop 驱动(scope / onChange / tabSubs / availableSubs /
 * onAddSub / onRemoveSub / overridesCountFor),不绑定任何具体的覆盖语义 ——
 * 由调用方(Rules 全量 overrides / Cards 仅卡片 overrides)各自计算 tab 列表与
 * 计数,从而在同一 Subscription.overrides 上各管各的切片。
 */

import { Avatar, Icon, Pill, TabBarShell, TabButton } from "@bilibili-notify/ui";
import { useEffect, useRef, useState } from "react";
import { colorFromUid, displayName } from "../pages/up/helpers";
import type { Subscription } from "../types/domain";

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

	useEffect(() => {
		if (!adding) return;
		function handleDocClick(e: MouseEvent) {
			if (!dropdownRef.current) return;
			if (!dropdownRef.current.contains(e.target as Node)) setAdding(false);
		}
		document.addEventListener("mousedown", handleDocClick);
		return () => document.removeEventListener("mousedown", handleDocClick);
	}, [adding]);

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
						// 挂点与同条 tab 条上的 TabButton 同口径 —— 此前「全局 / 全部 UP」有挂点、
						// 紧挨着的 per-UP tab 一个都没有,皮肤改 btn 时一条 tab 里第一颗变了、
						// 后面几颗没变,并排摆着。观感上两者仍有差(实底 vs 描边),那是另一条账。
						data-bn={active ? "btn btn-primary" : "btn"}
						className={`flex items-center gap-1.5 rounded-lg border py-1.5 pl-3 pr-1.5 text-[12.5px] font-bold transition ${
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
								<Pill color={active ? "#FB7299" : "#888"} subtle size="sm">
									{count}
								</Pill>
							) : null}
						</button>
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onRemoveSub(sub.id);
							}}
							title={`移除 ${displayName(sub)} 的个性化配置`}
							data-bn="btn"
							className={`grid h-4.5 w-4.5 place-items-center rounded-sm ${
								active
									? "text-bn-pink/80 hover:bg-bn-pink/10"
									: "text-bn-text-tertiary/70 hover:bg-bn-hover-muted"
							}`}
						>
							<Icon.close size={11} />
						</button>
					</div>
				);
			})}

			{/* 添加 UP 按钮 + 下拉 */}
			<div className="relative" ref={dropdownRef}>
				<button
					type="button"
					onClick={() => setAdding((v) => !v)}
					title="从订阅列表添加 UP 主的个性化配置"
					data-bn="btn"
					className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold transition ${
						adding
							? "border-bn-pink/40 bg-bn-pink/6 text-bn-pink"
							: "border-dashed border-bn-border text-bn-text-tertiary hover:text-bn-text-primary"
					}`}
				>
					<Icon.plus size={13} />
					添加 UP
				</button>
				{adding ? (
					<div
						data-bn="glass-strong"
						className="absolute left-0 top-[calc(100%+6px)] z-30 min-w-60 overflow-hidden rounded-bn-sm border border-bn-border-subtle bg-bn-surface shadow-bn-elev"
					>
						<div className="border-b border-bn-border-subtle px-3 pb-1.5 pt-2 text-[11px] font-bold uppercase tracking-wider text-bn-text-tertiary">
							选择要单独定制的 UP 主
						</div>
						{availableSubs.length === 0 ? (
							<div className="px-3 py-4 text-center text-[12px] text-bn-text-tertiary">
								所有已订阅的 UP 主都已添加
							</div>
						) : (
							<div className="max-h-72 overflow-y-auto py-1">
								{availableSubs.map((sub) => {
									const color = colorFromUid(sub.uid);
									return (
										<button
											type="button"
											key={sub.id}
											onClick={() => {
												onAddSub(sub.id);
												setAdding(false);
											}}
											className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-bn-pink/5"
										>
											<Avatar
												name={displayName(sub)}
												color={color}
												size={28}
												url={sub.cachedProfile?.avatar}
											/>
											<div className="min-w-0 flex-1">
												<div className="truncate text-[12.5px] font-bold text-bn-text-primary">
													{displayName(sub)}
												</div>
												<div className="text-[10.5px] text-bn-text-tertiary">UID {sub.uid}</div>
											</div>
											{sub.state.liveStatus === "live" ? (
												<Pill color="#FB7299" subtle size="sm">
													播
												</Pill>
											) : null}
										</button>
									);
								})}
							</div>
						)}
						<button
							type="button"
							onClick={() => setAdding(false)}
							className="block w-full border-t border-bn-border-subtle py-2 text-center text-[11px] text-bn-text-tertiary hover:text-bn-text-primary"
						>
							取消
						</button>
					</div>
				) : null}
			</div>

			<div className="flex-1" />
			<div className="px-2 text-[11px] text-bn-text-tertiary">
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
