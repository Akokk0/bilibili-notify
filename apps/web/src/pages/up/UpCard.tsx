import { useState } from "react";
import { Avatar, Pill, Toggle } from "../../components/atoms";
import { Icon } from "../../components/icons";
import { FEATURE_LABELS, type Subscription } from "../../types/domain";
import { activeFeatures, colorFromUid, displayName, relativeTime } from "./helpers";

const FEATURE_TONE: Record<string, string> = {
	dynamic: "#00AEEC",
	dynamicAtAll: "#00AEEC",
	live: "#FB7299",
	liveAtAll: "#FB7299",
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
}

export function UpCard({
	sub,
	selected,
	onClick,
	onToggleSelect,
	onToggleEnabled,
	togglePending,
}: UpCardProps) {
	const [hover, setHover] = useState(false);
	const color = colorFromUid(sub.uid);
	const features = activeFeatures(sub.routing);
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
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onClick();
				}
			}}
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			className={`group relative cursor-pointer overflow-hidden rounded-xl text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-bn-pink ${
				selected ? "ring-2 ring-bn-pink" : "ring-1 ring-gray-200"
			} ${hover ? "-translate-y-0.5 shadow-bn-elev" : "shadow-sm"} ${
				sub.enabled ? "" : "opacity-70"
			} bg-white`}
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
						className={`flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded border-0 ${
							selected ? "bg-bn-pink text-white" : "bg-white/90 text-bn-text-secondary"
						}`}
					>
						{selected ? <Icon.check size={12} /> : <span className="text-[11px]">☐</span>}
					</button>
				</div>
			</div>

			{/* body */}
			<div className="relative px-3.5 pb-3 pt-0">
				<div className="-mt-5 mb-2">
					<Avatar name={displayName(sub)} color={color} size={48} ring />
				</div>
				<div className="mb-1 flex items-center justify-between">
					<span
						className="max-w-[160px] truncate text-sm font-bold text-bn-text-primary"
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
