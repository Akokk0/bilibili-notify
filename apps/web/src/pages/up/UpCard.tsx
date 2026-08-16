import { Avatar, Icon, Pill, Toggle } from "@bilibili-notify/ui";
import { useState } from "react";
import { useLongPress } from "../../hooks/useLongPress";
import { FEATURE_LABELS, type Subscription } from "../../types/domain";
import { colorFromUid, displayName, relativeTime, subscribedFeatures } from "./helpers";

const FEATURE_TONE: Record<string, string> = {
	dynamic: "#00AEEC",
	live: "#FB7299",
	liveEnd: "#FB7299",
	liveGuardBuy: "#f2a053",
	superchat: "#fdcb6e",
	wordcloud: "#a29bfe",
	liveSummary: "#a29bfe",
	specialDanmaku: "#a29bfe",
	specialUserEnter: "#a29bfe",
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
			className={`bn-glass group relative cursor-pointer overflow-hidden rounded-xl text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-bn-pink ${
				selected ? "ring-2 ring-bn-pink" : ""
			} ${hover ? "-translate-y-0.5 shadow-bn-elev" : "shadow-sm"} ${
				sub.enabled ? "" : "opacity-70"
			}`}
		>
			{/* cover band */}
			<div
				className="relative h-14"
				style={{
					background: `linear-gradient(135deg, ${color}66, ${color}33)`,
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
						className={`flex h-5.5 w-5.5 cursor-pointer items-center justify-center rounded border-0 ${
							selected ? "bg-bn-pink text-white" : "bg-bn-surface/90 text-bn-text-secondary"
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
						className="max-w-40 truncate text-sm font-bold text-bn-text-primary"
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
				<div className="mb-2.5 flex items-center gap-1.5 text-[11px] text-bn-text-secondary">
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
					<div className="mb-2.5 flex items-start gap-1 rounded-md border border-bn-danger-border bg-bn-danger-soft px-2 py-1.5 text-[10.5px] leading-snug text-bn-danger-text">
						<Icon.warning size={12} className="mt-px shrink-0" />
						<span>
							未关注该 UP —— 收不到动态
							{sub.followError ? <span className="opacity-80">（{sub.followError}）</span> : null}
						</span>
					</div>
				) : null}
				<div className="mb-2.5 flex flex-wrap gap-1">
					{features.length === 0 ? (
						<span className="text-[10px] text-bn-text-secondary">未配置任何推送特性</span>
					) : (
						features.map((f) => (
							<Pill key={f} color={FEATURE_TONE[f] ?? "#999"} subtle size="sm">
								{FEATURE_LABELS[f]}
							</Pill>
						))
					)}
				</div>
				{sub.notes ? (
					<div
						className="mb-2 truncate text-[11px] italic text-bn-text-secondary"
						title={sub.notes}
					>
						{sub.notes}
					</div>
				) : null}
				<div className="flex items-center justify-between text-[11px] text-bn-text-secondary">
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
