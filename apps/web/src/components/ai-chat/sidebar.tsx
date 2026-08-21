import type { AiChatMode } from "@bilibili-notify/contract";
import { Icon, IconButton } from "@bilibili-notify/ui";
import { useState } from "react";
import { type AiConversationMetaDTO, groupConversations } from "../../services/aiChat";
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
	/**
	 * 开一场新对话,面孔在这一刻定死(见 {@link AiChatMode})。
	 *
	 * 参数不是可选的:模式已经不在聊天框里选了,这颗按钮**就是**那个选择动作。
	 */
	onNew: (mode: AiChatMode) => void;
	onDelete: (id: string) => void;
	onCollapse: () => void;
	/** 底部显示的模型名;没配置时留空。 */
	modelName?: string;
	userName: string;
	/** B 站头像 URL;取不到时回落成首字色块。 */
	userFace?: string;
	/** 女仆的名字,取自人格配置(见 {@link resolveChatPersona})。 */
	aiName: string;
}

export function ChatSidebar(props: ChatSidebarProps) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const groups = groupConversations(props.conversations);

	return (
		<div className="bn-glass-sheen bn-glass-strong m-3 flex w-[258px] shrink-0 flex-col rounded-3xl px-3 pb-3 pt-3.5 shadow-bn-elev">
			<div className="flex items-center gap-1.5 px-0.5 pb-4">
				<div className="flex-1 truncate pl-2 text-[14.5px] font-bold text-bn-text-primary">
					女仆AI · {props.aiName}
				</div>
				<IconButton
					icon={<Icon.panelCollapse size={18} />}
					label="收起侧栏"
					size="xl"
					onClick={props.onCollapse}
				/>
			</div>

			{/* 两个入口 = 两种面孔。工坊那颗矮一档、字小一号:它是偏门的那一个,
			    平起平坐会让主人每次开对话都要先做一道选择题。 */}
			<div className="mb-[18px] flex flex-col gap-1.5">
				<button
					type="button"
					onClick={() => props.onNew("chat")}
					className="flex w-full cursor-pointer items-center gap-2 rounded-xl bg-bn-code-bg px-3 py-2.5 text-[13px] font-semibold text-bn-text-tertiary bn-chat-accent-soft-hover transition-colors"
				>
					<Icon.plus size={16} /> 开启新对话
				</button>
				<button
					type="button"
					onClick={() => props.onNew("skin")}
					className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-[12px] font-semibold text-bn-text-secondary bn-chat-accent-soft-hover transition-colors"
				>
					<Icon.palette size={15} /> 新建皮肤工坊
				</button>
			</div>

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
									className={`group/row flex items-center rounded-bn-sm transition-colors ${
										c.id === props.activeId ? "bn-chat-accent-soft" : "hover:bg-bn-code-bg"
									}`}
								>
									<button
										type="button"
										onClick={() => props.onSelect(c.id)}
										className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-3 py-2.5 text-left text-[12.5px] text-bn-text-tertiary"
									>
										<span className="min-w-0 flex-1 truncate">{c.title}</span>
										<ConversationLabel mode={c.mode} persona={c.persona} />
									</button>
									<IconButton
										icon={<Icon.close size={13} />}
										label={`删除对话「${c.title}」`}
										title="删除这个对话"
										size="md"
										tone="danger"
										className="mr-1.5 opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100"
										onClick={() => props.onDelete(c.id)}
									/>
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
						data-bn="avatar"
						className="h-[30px] w-[30px] shrink-0 rounded-full object-cover"
					/>
				) : (
					<div
						data-bn="avatar"
						className="bn-chat-accent-grad grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-[12.5px] font-bold text-bn-on-solid"
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
				<IconButton
					icon={<Icon.gear size={17} />}
					label="聊天设置"
					title="设置"
					size="xl"
					ariaExpanded={settingsOpen}
					onClick={() => setSettingsOpen((v) => !v)}
				/>

				{settingsOpen ? (
					<div className="bn-glass-sheen bn-glass-strong bn-anim-fade-up absolute inset-x-0 bottom-[calc(100%+8px)] z-bn-local rounded-2xl p-3 shadow-bn-elev">
						{/* 主题色与玻璃质感都不在这里:四色预设已砍,玻璃族直接吃
						    --bn-glass-* token —— 观感调整一律走皮肤包(皮肤编辑器)。
						    弹层里只剩与皮肤无关的行为设置。 */}
						{/* 思考深度(ai.chat.thinkingLevel)。组件自带查询与落盘,弹层这边
						    不用为它多穿一层 props —— 与 ✦ 胶囊(ThinkingControl)同款自理。 */}
						<ThinkingLevelSetting />
					</div>
				) : null}
			</div>
		</div>
	);
}

/**
 * 会话行右边那块小牌 —— **只标非默认的那一档**。
 *
 * 默认(聊天 + 有人格)什么都不挂:一列全是标签的话,真正特殊的那几行反而淹了。
 * 工坊会话也只挂一块 —— 那条路本来就没有人格,再标一次「无人格」是废话。
 *
 * 两个字段缺失都按默认算(老会话文件里没有它们),与服务端读盘时补的那套默认同口径。
 */
function ConversationLabel({ mode, persona }: { mode: AiChatMode; persona: boolean }) {
	const text = mode === "skin" ? "工坊" : persona ? null : "无人格";
	if (!text) return null;
	return (
		<span
			data-conv-label={text}
			className="shrink-0 rounded-bn-xs bg-bn-hover-muted px-1.5 py-0.5 text-[9.5px] font-bold text-bn-text-secondary"
		>
			{text}
		</span>
	);
}
