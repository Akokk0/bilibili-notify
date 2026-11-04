import { subscriptionIdentityLabel } from "@bilibili-notify/contract";
import { formatCount } from "@bilibili-notify/internal/format";
import { Avatar, ErrorNote, Icon, Pill, Toggle, WarnNote } from "@bilibili-notify/ui";
import { type ReactNode, useState } from "react";
import { DescriptorIcon } from "../../components/platform-meta";
import { PUSH_TONE } from "../../config/push-features";
import { useLongPress } from "../../hooks/useLongPress";
import { useT } from "../../i18n";
import {
	type FeatureFlagValues,
	type Subscription,
	type SubscriptionTag,
	subscriptionIdentityOf,
} from "../../types/domain";
import { displayName, profileAvatarUrl, subscribedFeatures, subscriptionColor } from "./helpers";
import { RelativeTime } from "./relative-time";
import {
	featureLabelOf,
	type SubscriptionPlatform,
	visibleFeaturesOf,
} from "./subscription-source";

/**
 * 订阅功能开关的胶囊色。键空间是 FeatureKey(历史行与推送色表用的也是它),
 * 用的是同一套家族色,所以借 PUSH_TONE 而不是再抄一份十六进制。两档衍生能力
 * (特别弹幕/特别进房)统一走 derived。
 */
const FEATURE_TONE: Record<string, string> = {
	post: PUSH_TONE.post,
	liveStart: PUSH_TONE.live,
	liveStreaming: PUSH_TONE.live,
	liveEnd: PUSH_TONE.live,
	membership: PUSH_TONE.membership,
	superchat: PUSH_TONE.superchat,
	viewerChat: PUSH_TONE.derived,
	viewerEnter: PUSH_TONE.derived,
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
	/** Current source descriptor projection, including status and declared capabilities. */
	platform: SubscriptionPlatform;
	extensionSettings?: ReactNode;
	/**
	 * 标签表(ADR-0034):订阅上只记标签 id,角标上写的名字得按 id 到这里查。没读到(`undefined`)
	 * 或表里没有那个 id,都当没挂标签 —— 什么都不写。
	 */
	tags?: ReadonlyArray<SubscriptionTag>;
	/** 全局特性开关,没覆盖的订阅继承它(见 `UpDialog` 的同名属性);不给 = 出厂值。 */
	globalFeatures?: FeatureFlagValues;
}

/**
 * UP 卡与末尾那张「添加 UP 主」卡**共用**的最小高度。
 *
 * grid 同一行的高度由最高的那张卡决定。这个值从前只写在添加卡上,UP 卡自己没有
 * —— 于是一切到标签筛选(添加卡按设计不出现),整排 UP 卡当场矮一截。两处引同一个
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
	platform,
	extensionSettings,
	tags,
	globalFeatures,
}: UpCardProps) {
	const tx = useT();
	const [hover, setHover] = useState(false);
	const longPress = useLongPress({ onLongPress: onRequestMenu });
	const color = subscriptionColor(sub, platform);
	const identity = subscriptionIdentityOf(sub);
	const ext = platform;
	const visible = visibleFeaturesOf(sub, ext);
	const features = subscribedFeatures(sub, globalFeatures).filter((k) => visible.includes(k));
	const paused = ext.absent === true || (ext.status !== "running" && ext.status !== "unknown");
	const fans = sub.cachedProfile?.followers;
	const fansLabel =
		fans == null
			? tx("sourceUi.pages.up.UpCard.UpCard.1")
			: tx("sourceUi.pages.up.UpCard.UpCard.2", { value1: formatCount(fans) });
	// Display order belongs to the registry; subscription tagIds remain unchanged.
	const cardTags = (tags ?? []).filter((tag) => sub.tagIds.includes(tag.id));
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
				sub.enabled && !paused ? "" : "opacity-70"
			} ${paused ? "grayscale" : ""}`}
		>
			{/* cover band */}
			<div
				className="relative h-14"
				style={{
					background: `linear-gradient(135deg, color-mix(in srgb, ${color} 40%, transparent), color-mix(in srgb, ${color} 20%, transparent))`,
				}}
			>
				<div className="absolute right-2 top-2 flex items-center gap-1">
					<button
						type="button"
						aria-pressed={selected}
						aria-label={
							selected
								? tx("sourceUi.pages.up.UpCard.arialabel.3")
								: tx("sourceUi.pages.up.UpCard.arialabel.4")
						}
						onClick={(e) => {
							e.stopPropagation();
							onToggleSelect();
						}}
						className={`${hover || selected ? "opacity-100" : "opacity-0 focus-visible:opacity-100"} flex h-5.5 w-5.5 cursor-pointer items-center justify-center rounded-sm border-0 ${
							selected ? "bg-bn-pink text-bn-on-solid" : "bg-bn-surface/90 text-bn-text-secondary"
						}`}
					>
						{selected ? <Icon.check size={12} /> : <Icon.square size={12} />}
					</button>
					{extensionSettings}
				</div>
			</div>

			{/* body */}
			<div className="relative px-3.5 pb-3 pt-0">
				<div className="-mt-5 mb-2">
					<Avatar
						name={displayName(sub, ext)}
						color={color}
						size={48}
						url={profileAvatarUrl(sub.cachedProfile)}
						ring
					/>
				</div>
				<div className="mb-1 flex items-center justify-between">
					<span
						className="max-w-40 truncate text-bn-base font-bold text-bn-text-primary"
						title={displayName(sub, ext)}
					>
						{displayName(sub, ext)}
					</span>
					<Toggle
						value={sub.enabled}
						onChange={onToggleEnabled}
						size="sm"
						disabled={togglePending}
					/>
				</div>
				<div className="mb-2.5 flex items-center gap-1.5 text-bn-xs text-bn-text-secondary">
					{ext.showBadge ? (
						<span
							role="img"
							aria-label={ext.label}
							title={ext.label}
							className="inline-flex shrink-0 items-center"
						>
							{ext.icon ? (
								<DescriptorIcon
									descriptor={{
										icon: ext.icon,
										color: ext.color ?? "var(--color-bn-inactive)",
										shortLabel: ext.shortLabel ?? ext.label,
									}}
									size={16}
								/>
							) : (
								<Icon.globe size={16} />
							)}
						</span>
					) : null}
					<span className="min-w-0 flex-1 truncate tabular-nums">
						{subscriptionIdentityLabel(identity, ext)}
					</span>
					<span className="shrink-0">·</span>
					<span className="shrink-0 whitespace-nowrap tabular-nums">{fansLabel}</span>
				</div>
				{paused && ext ? (
					<WarnNote size="sm" icon={<Icon.extension size={12} />} className="mb-2.5">
						{ext.absent
							? tx("sourceUi.pages.up.UpCard.sourceAbsent", { source: ext.label })
							: tx("sourceUi.pages.up.UpCard.UpCard.5", { source: ext.label })}
					</WarnNote>
				) : null}
				{/* 挂在这条订阅上的问题(服务端从问题表 join 来):每条一个,不看来源、不看 code。 */}
				{sub.problems.map((problem) => (
					<ErrorNote
						key={`${problem.reporter}/${problem.code}`}
						size="sm"
						icon={<Icon.warning size={12} />}
						className="mb-2.5"
					>
						{problem.message}
					</ErrorNote>
				))}
				<div className="mb-2.5 flex flex-wrap gap-1">
					{features.length === 0 ? (
						<span className="text-bn-2xs text-bn-text-secondary">
							{tx("sourceUi.pages.up.UpCard.UpCard.6")}
						</span>
					) : (
						features.map((f) => (
							<Pill key={f} color={FEATURE_TONE[f] ?? "var(--color-bn-inactive)"} subtle size="sm">
								{featureLabelOf(f, ext)}
							</Pill>
						))
					)}
				</div>
				{sub.notes ? (
					<div className="mb-2 truncate text-bn-xs italic text-bn-text-secondary" title={sub.notes}>
						{sub.notes}
					</div>
				) : null}
				{cardTags.length > 0 ? (
					<ul
						aria-label={tx("subscriptionTags.cardLabels")}
						className="m-0 mb-2.5 flex min-w-0 list-none flex-wrap gap-1 p-0"
					>
						{cardTags.map((tag) => (
							<li key={tag.id} className="max-w-full" title={tag.name}>
								<Pill color="var(--color-bn-pink)" subtle size="sm">
									<span className="break-all">{tag.name}</span>
								</Pill>
							</li>
						))}
					</ul>
				) : null}
				<div className="text-right text-bn-xs text-bn-text-secondary">
					{tx("sourceUi.pages.up.UpCard.UpCard.8")}{" "}
					<RelativeTime at={sub.cachedProfile?.refreshedAt} />
				</div>
			</div>
		</div>
	);
}
