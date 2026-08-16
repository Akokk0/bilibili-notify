import { Icon, Toggle } from "@bilibili-notify/ui";
import { useState } from "react";
import { type AiConversationMetaDTO, groupConversations } from "../../services/aiChat";
import { CHAT_THEME_LABELS, CHAT_THEMES, type ChatTheme } from "../../store/aiChat";
import { useCurrentSkinMode } from "../skin-root";
import { ThinkingLevelSetting } from "./thinking-level-setting";

/**
 * 聊天页左侧的会话栏 —— 悬浮的液态玻璃面板(macOS 26 风)。
 *
 * 「最近」列的是**服务端**的会话记录,所以换台设备、重启服务都还在。分组标签
 * (今天 / 昨天 / 更早)由 groupConversations 派生,组内次序沿用服务端的倒序。
 */

export interface ChatSidebarProps {
	conversations: readonly AiConversationMetaDTO[];
	activeId: string | null;
	onSelect: (id: string) => void;
	onNew: () => void;
	onDelete: (id: string) => void;
	onCollapse: () => void;
	theme: ChatTheme;
	onThemeChange: (next: ChatTheme) => void;
	/** 底部显示的模型名;没配置时留空。 */
	modelName?: string;
	userName: string;
	/** B 站头像 URL;取不到时回落成首字色块。 */
	userFace?: string;
	/** 女仆的名字,取自人格配置(见 {@link resolveChatPersona})。 */
	aiName: string;
	/** 玻璃片透明度 0..1;{@link glassClear} 开着时这个值留着但不生效。 */
	glassOpacity: number;
	onGlassOpacityChange: (next: number) => void;
	glassClear: boolean;
	onGlassClearChange: (next: boolean) => void;
}

export function ChatSidebar(props: ChatSidebarProps) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	// 皮肤(含试穿/预览)生效 → chat 观感由皮肤接管,四色预设节隐藏。
	const skinOn = useCurrentSkinMode() !== null;
	const groups = groupConversations(props.conversations);

	return (
		<div className="bn-glass-sheen bn-glass-panel m-3 flex w-[258px] shrink-0 flex-col rounded-3xl px-3 pb-3 pt-3.5 shadow-[0_14px_44px_rgba(42,30,72,0.16)]">
			<div className="flex items-center gap-1.5 px-0.5 pb-4">
				<div className="flex-1 truncate pl-2 text-[14.5px] font-bold text-bn-text-primary">
					女仆AI · {props.aiName}
				</div>
				<button
					type="button"
					title="收起侧栏"
					aria-label="收起侧栏"
					onClick={props.onCollapse}
					className="grid h-[34px] w-[34px] cursor-pointer place-items-center rounded-[9px] text-bn-text-tertiary transition-colors hover:bg-bn-hover-muted"
				>
					<Icon.panelCollapse size={18} />
				</button>
			</div>

			<button
				type="button"
				onClick={props.onNew}
				className="mb-[18px] flex w-full cursor-pointer items-center gap-2 rounded-xl bg-bn-code-bg px-3 py-2.5 text-[13px] font-semibold text-bn-text-tertiary bn-chat-accent-soft-hover transition-colors"
			>
				<Icon.plus size={16} /> 开启新对话
			</button>

			<div className="flex-1 overflow-y-auto">
				{groups.length === 0 ? (
					<div className="px-3 py-2 text-xs leading-relaxed text-bn-text-secondary">
						还没有聊过天呢～
						<br />
						点上面那颗按钮开个新对话吧
					</div>
				) : (
					groups.map((g) => (
						<div key={g.label} className="mb-1">
							<div className="px-3 pb-[7px] pt-0.5 text-[10.5px] font-bold tracking-wider text-bn-text-secondary">
								{g.label}
							</div>
							{g.items.map((c) => (
								// group/row:删除键平时隐身,悬停整行才浮出来 —— 一排常驻的
								// × 会把侧栏变成一列垃圾桶。
								<div
									key={c.id}
									className={`group/row flex items-center rounded-[9px] transition-colors ${
										c.id === props.activeId ? "bn-chat-accent-soft" : "hover:bg-bn-code-bg"
									}`}
								>
									<button
										type="button"
										onClick={() => props.onSelect(c.id)}
										className="min-w-0 flex-1 cursor-pointer truncate px-3 py-2.5 text-left text-[12.5px] text-bn-text-tertiary"
									>
										{c.title}
									</button>
									<button
										type="button"
										title="删除这个对话"
										aria-label={`删除对话「${c.title}」`}
										onClick={() => props.onDelete(c.id)}
										className="mr-1.5 grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded text-bn-text-secondary opacity-0 transition hover:bg-bn-hover-muted hover:text-bn-danger-text focus-visible:opacity-100 group-hover/row:opacity-100"
									>
										<Icon.close size={13} />
									</button>
								</div>
							))}
						</div>
					))
				)}
			</div>

			<div className="relative mt-1.5 flex items-center gap-2.5 px-2 pb-0.5 pt-2.5">
				{/* 有真头像就用真头像。referrerPolicy 不能省 —— B 站图床按 Referer 防盗链,
				    带上本站 Referer 会被回一张 403 占位图,头像位置变成一块裂图。
				    与 header 里的账号头像同一处理。 */}
				{props.userFace ? (
					<img
						src={props.userFace}
						alt={props.userName}
						referrerPolicy="no-referrer"
						className="h-[30px] w-[30px] shrink-0 rounded-full object-cover"
					/>
				) : (
					<div
						className="bn-chat-accent-grad grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-[12.5px] font-bold text-white"
						aria-hidden="true"
					>
						{props.userName.slice(0, 1)}
					</div>
				)}
				<div className="min-w-0 flex-1">
					<div className="truncate text-[12.5px] font-semibold text-bn-text-primary">
						{props.userName}
					</div>
					<div className="truncate text-[10.5px] text-bn-text-secondary">
						{props.modelName || "尚未配置模型"}
					</div>
				</div>
				<button
					type="button"
					title="设置"
					aria-label="聊天设置"
					aria-expanded={settingsOpen}
					onClick={() => setSettingsOpen((v) => !v)}
					className="grid h-[34px] w-[34px] cursor-pointer place-items-center rounded-[9px] text-bn-text-tertiary transition-colors hover:bg-bn-hover-muted"
				>
					<Icon.gear size={17} />
				</button>

				{settingsOpen ? (
					<div className="bn-glass-sheen bn-glass-popover bn-anim-fade-up absolute inset-x-0 bottom-[calc(100%+8px)] z-20 rounded-2xl p-3 shadow-[0_12px_36px_rgba(42,30,72,0.18)]">
						{/* 皮肤生效时 chat 观感整体由皮肤接管:四色预设不再有意义,整节隐藏;
						    默认装下照常。玻璃质感/思考深度与皮肤无关,永远在。 */}
						{skinOn ? null : (
							<>
								<div className="mb-2.5 pl-0.5 text-[11px] font-bold tracking-wide text-bn-text-secondary">
									主题色
								</div>
								<div className="flex gap-2">
									{CHAT_THEMES.map((id) => {
										const active = props.theme === id;
										return (
											<button
												key={id}
												type="button"
												title={CHAT_THEME_LABELS[id]}
												aria-pressed={active}
												onClick={() => props.onThemeChange(id)}
												data-chat-theme={id}
												className={`flex flex-1 cursor-pointer flex-col items-center gap-[5px] rounded-[10px] border-[1.5px] px-0.5 py-2 transition ${
													active
														? "bn-glass-selected border-[var(--bn-chat-dot)]"
														: "border-transparent hover:bg-bn-code-bg"
												}`}
											>
												<span
													// 选中圈用 --bn-chat-ring 而不是写死的半透明白:暗色下白圈会在
													// 深底上炸成一圈光晕,比色点本身还抢眼。
													className="h-[22px] w-[22px] rounded-full"
													style={{
														background: "var(--bn-chat-dot)",
														boxShadow: active
															? "0 0 0 3px var(--bn-chat-ring), 0 2px 6px rgba(0,0,0,0.18)"
															: "0 1px 4px rgba(0,0,0,0.12)",
													}}
												/>
												<span
													// nowrap:「紫罗兰」三个字在 1/4 宽的格子里会折成「紫罗 / 兰」,
													// 把那一格顶高一截,四个色卡立刻参差不齐。
													className={`whitespace-nowrap text-[10.5px] font-semibold ${
														active ? "text-bn-text-primary" : "text-bn-text-secondary"
													}`}
												>
													{CHAT_THEME_LABELS[id]}
												</span>
											</button>
										);
									})}
								</div>
							</>
						)}

						{/* 玻璃质感。跟推送卡片那对同名同义(玻璃片透明度 + 完全透明),
						    主人在两处看到的是同一套说法,默认值也是同一个数。 */}
						<div className="mb-2 mt-3.5 pl-0.5 text-[11px] font-bold tracking-wide text-bn-text-secondary">
							玻璃质感
						</div>
						<div className="flex h-7 items-center gap-2.5 px-0.5">
							<input
								type="range"
								min={0}
								max={1}
								step={0.02}
								aria-label="玻璃片透明度"
								// 开着完全透明时**禁用而不是藏起来**:藏掉的话主人看不见自己原来
								// 调的是哪一档,关掉之后会突然跳回一个自己记不得的值。
								disabled={props.glassClear}
								value={props.glassOpacity}
								onChange={(e) => props.onGlassOpacityChange(Number(e.target.value))}
								className="bn-chat-accent-range flex-1 disabled:opacity-40"
							/>
							<span className="w-8 shrink-0 text-right font-mono text-[10.5px] text-bn-text-secondary">
								{props.glassOpacity.toFixed(2)}
							</span>
						</div>
						<div className="mt-2 flex items-center gap-2 px-0.5 text-[11px] text-bn-text-secondary">
							<Toggle
								size="sm"
								ariaLabel="完全透明(去磨砂模糊)"
								value={props.glassClear}
								onChange={props.onGlassClearChange}
							/>
							完全透明（去磨砂模糊）
						</div>

						{/* 思考深度(ai.chat.thinkingLevel)。组件自带查询与落盘,弹层这边
						    不用为它多穿一层 props —— 与 ✦ 胶囊(ThinkingControl)同款自理。 */}
						<ThinkingLevelSetting />
					</div>
				) : null}
			</div>
		</div>
	);
}
