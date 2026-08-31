import { Avatar, ErrorNote, Icon, Pill, Toggle } from "@bilibili-notify/ui";
import { useState } from "react";
import { PUSH_TONE } from "../../config/push-kinds";
import { useLongPress } from "../../hooks/useLongPress";
import { FEATURE_LABELS, type Subscription } from "../../types/domain";
import { colorFromUid, displayName, relativeTime, subscribedFeatures } from "./helpers";

/**
 * 订阅功能开关的胶囊色。键空间是 FeatureKey(与推送事件的 HistorySource 不同 ——
 * 多了 liveEnd / wordcloud),但用的是同一套家族色,所以借 PUSH_TONE 而不是再抄
 * 一份十六进制。四档衍生能力(词云/总结/特别弹幕/特别进房)统一走 derived。
 */
const FEATURE_TONE: Record<string, string> = {
	dynamic: PUSH_TONE.dynamic,
	live: PUSH_TONE.live,
	liveEnd: PUSH_TONE.live,
	liveGuardBuy: PUSH_TONE.guard,
	superchat: PUSH_TONE.sc,
	wordcloud: PUSH_TONE.derived,
	liveSummary: PUSH_TONE.derived,
	specialDanmaku: PUSH_TONE.derived,
	specialUserEnter: PUSH_TONE.derived,
};

export interface UpCardProps {
	sub: Subscription;
	selected: boolean;
	onClick: () => void;
	onToggleSelect: () => void;
	onToggleEnabled: (next: boolean) => void;
	togglePending: boolean;
	/** 右键 / 长按请求在给定坐标弹出快捷菜单。 */
	onRequestMenu: (pos: { x: number; y: number }) => void;
}

/**
 * UP 卡与末尾那张「添加 UP 主」卡**共用**的最小高度。
 *
 * grid 同一行的高度由最高的那张卡决定。这个值从前只写在添加卡上,UP 卡自己没有
 * —— 于是一切到分组筛选(添加卡按设计不出现),整排 UP 卡当场矮一截。两处引同一个
 * 常量,谁也别再替谁撑着。
 */
export const UP_CARD_MIN_H = "min-h-55";

export function UpCard({
	sub,
	selected,
	onClick,
	onToggleSelect,
	onToggleEnabled,
	togglePending,
	onRequestMenu,
}: UpCardProps) {
	const [hover, setHover] = useState(false);
	const longPress = useLongPress({ onLongPress: onRequestMenu });
	const color = colorFromUid(sub.uid);
	const features = subscribedFeatures(sub);
	const fans = sub.cachedProfile?.fans;
	const fansLabel =
		fans == null
			? "粉丝数未刷新"
			: fans >= 10_000
				? `${(fans / 10_000).toFixed(1)}万 粉丝`
				: `${fans} 粉丝`;
	return (
		// biome-ignore lint/a11y/useSemanticElements: outer card holds inner <button>s (select / enabled toggle); nested HTML <button> is invalid, so a div + role=button is the right escape.
		<div
			role="button"
			tabIndex={0}
			onClick={onClick}
			onClickCapture={longPress.onClickCapture}
			onPointerDown={longPress.onPointerDown}
			onPointerMove={longPress.onPointerMove}
			onPointerUp={longPress.onPointerUp}
			onContextMenu={(e) => {
				e.preventDefault();
				onRequestMenu({ x: e.clientX, y: e.clientY });
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onClick();
				}
			}}
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			// 玻璃底(皮肤壁纸可透出);玻璃卡无描边(卡片风),未选中态靠阴影分层,选中态叠粉色 ring
			className={`bn-glass group relative cursor-pointer overflow-hidden rounded-xl text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-bn-pink ${UP_CARD_MIN_H} ${
				selected ? "ring-2 ring-bn-pink" : ""
			} ${hover ? "-translate-y-0.5 shadow-bn-elev" : "shadow-bn-card"} ${
				sub.enabled ? "" : "opacity-70"
			}`}
		>
			{/* cover band */}
			<div
				className="relative h-14"
				style={{
					background: `linear-gradient(135deg, color-mix(in srgb, ${color} 40%, transparent), color-mix(in srgb, ${color} 20%, transparent))`,
				}}
			>
				<div
					className={`absolute right-2 top-2 flex gap-1 transition ${
						hover || selected ? "opacity-100" : "opacity-0"
					}`}
				>
					<button
						type="button"
						aria-pressed={selected}
						aria-label={selected ? "已选" : "选择"}
						onClick={(e) => {
							e.stopPropagation();
							onToggleSelect();
						}}
						className={`flex h-5.5 w-5.5 cursor-pointer items-center justify-center rounded-sm border-0 ${
							selected ? "bg-bn-pink text-bn-on-solid" : "bg-bn-surface/90 text-bn-text-secondary"
						}`}
					>
						{selected ? <Icon.check size={12} /> : <Icon.square size={12} />}
					</button>
				</div>
			</div>

			{/* body */}
			<div className="relative px-3.5 pb-3 pt-0">
				<div className="-mt-5 mb-2">
					<Avatar
						name={displayName(sub)}
						color={color}
						size={48}
						url={sub.cachedProfile?.avatar}
						ring
					/>
				</div>
				<div className="mb-1 flex items-center justify-between">
					<span
						className="max-w-40 truncate text-bn-base font-bold text-bn-text-primary"
						title={displayName(sub)}
					>
						{displayName(sub)}
					</span>
					<Toggle
						value={sub.enabled}
						onChange={onToggleEnabled}
						size="sm"
						disabled={togglePending}
					/>
				</div>
				<div className="mb-2.5 flex items-center gap-1.5 text-bn-xs text-bn-text-secondary">
					<span>UID {sub.uid}</span>
					<span>·</span>
					<span>{fansLabel}</span>
				</div>
				{/*
				 * 未关注 = 收不到动态。动态走 feed/all(关注流),没关注该 UP 就一条都拿不到 ——
				 * 这条订阅看着正常,实际是哑的。所以是**故障**不是提示:显眼、常驻,而不是创建
				 * 时一闪而过的 toast。followed===undefined(服务端没检查过 / 老数据)不显示,
				 * 那不等于「未关注」,别凭空吓人。
				 */}
				{sub.followed === false ? (
					<ErrorNote size="sm" icon={<Icon.warning size={12} />} className="mb-2.5">
						未关注该 UP —— 收不到动态
						{sub.followError ? <span className="opacity-80">（{sub.followError}）</span> : null}
					</ErrorNote>
				) : null}
				<div className="mb-2.5 flex flex-wrap gap-1">
					{features.length === 0 ? (
						<span className="text-bn-2xs text-bn-text-secondary">未配置任何推送特性</span>
					) : (
						features.map((f) => (
							<Pill key={f} color={FEATURE_TONE[f] ?? "var(--color-bn-inactive)"} subtle size="sm">
								{FEATURE_LABELS[f]}
							</Pill>
						))
					)}
				</div>
				{sub.notes ? (
					<div className="mb-2 truncate text-bn-xs italic text-bn-text-secondary" title={sub.notes}>
						{sub.notes}
					</div>
				) : null}
				<div className="flex items-center justify-between text-bn-xs text-bn-text-secondary">
					<span>
						分组：
						<span className="text-bn-text-tertiary">{sub.groups[0] ?? "默认"}</span>
					</span>
					<span>· 更新于 {relativeTime(sub.cachedProfile?.lastRefreshedAt)}</span>
				</div>
			</div>
		</div>
	);
}
