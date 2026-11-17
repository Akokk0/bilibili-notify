import type {
	FollowersGrain,
	FollowersTrend,
	SubscriptionView,
	UpStatsRow,
	VideoViewsTrend,
} from "@bilibili-notify/contract";
import { Btn, ErrorNote, GlassPanel, Icon, LoadingBlock, Toggle } from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Picker } from "../../components/forms";
import { patchCoreSettings, SETTINGS_KEY, useCoreSettings } from "../../hooks/useSettings";
import { useT } from "../../i18n";
import { api } from "../../services/api";
import { errorTextOf } from "../../services/error-text";
import { cumulativeFans, dayAxis, followersTrendLabels, sparseLabels } from "../../services/stats";
import { ResponsiveChart, TrendChart } from "./charts";

export type CreatorTrendMetric = "followers" | "videoViews";
export type VideoViewsScope = "current" | "all";

interface CreatorTrendPanelProps {
	metric: CreatorTrendMetric;
	onMetricChange(metric: CreatorTrendMetric): void;
	scope: VideoViewsScope;
	onScopeChange(scope: VideoViewsScope): void;
	row: UpStatsRow;
	name: string;
	color: string;
	days: number;
	grain: FollowersGrain;
	onGrainChange(grain: FollowersGrain): void;
	loading: boolean;
	followersTrend?: FollowersTrend;
	videoViewsTrend?: VideoViewsTrend;
	subscription?: SubscriptionView;
}

export function CreatorTrendPanel({
	row,
	name,
	color,
	days,
	grain,
	onGrainChange,
	loading,
	followersTrend,
	videoViewsTrend,
	subscription,
	metric,
	onMetricChange,
	scope,
	onScopeChange,
}: CreatorTrendPanelProps) {
	const tx = useT();
	const qc = useQueryClient();
	const settings = useCoreSettings();
	const video = videoViewsTrend?.rows.find((one) => one.subscriptionId === row.subscriptionId);
	const isVideo = metric === "videoViews";
	const supported = video?.supported;
	const allEnabled = settings.data?.defaults.stats?.videoViews === true;
	const own = subscription?.overrides.stats?.videoViews;
	const enabled = own ?? allEnabled;
	const hasVideoSamples = video?.values.some((value) => value !== null) === true;
	const save = useMutation({
		mutationFn: async ({
			id,
			scope,
			enabled,
		}: {
			id: string;
			scope: "current" | "all";
			enabled: boolean | null;
		}) => {
			if (scope === "all") {
				const saved = await patchCoreSettings({ defaults: { stats: { videoViews: enabled } } });
				qc.setQueryData(SETTINGS_KEY, saved);
			} else {
				const saved = await api.patch<SubscriptionView>(
					`/api/subscriptions/${encodeURIComponent(id)}`,
					{ overrides: { stats: { videoViews: enabled } } },
				);
				qc.setQueryData<SubscriptionView[]>(["subscriptions"], (old) =>
					old?.map((one) => (one.id === id ? saved : one)),
				);
			}
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["stats"] }),
	});
	const controls = (
		<>
			<fieldset
				disabled={save.isPending || !subscription}
				className="flex flex-wrap items-center justify-center gap-3 disabled:opacity-60"
				aria-label={tx("stats.videoViews.collection")}
			>
				<fieldset aria-label={tx("stats.videoViews.scope")}>
					<Picker
						value={scope}
						onChange={onScopeChange}
						options={[
							{ value: "current", label: tx("stats.videoViews.current") },
							{ value: "all", label: tx("stats.videoViews.all") },
						]}
					/>
				</fieldset>
				<span className="flex items-center gap-2 text-bn-sm text-bn-text-primary">
					{tx("stats.videoViews.collect")}
					<Toggle
						value={scope === "all" ? allEnabled : enabled}
						disabled={save.isPending || !subscription}
						onChange={(enabled) => save.mutate({ id: row.subscriptionId, scope, enabled })}
						ariaLabel={tx("stats.videoViews.collect")}
					/>
				</span>
				{scope === "current" && own !== undefined ? (
					<Btn
						size="sm"
						variant="ghost"
						onClick={() => save.mutate({ id: row.subscriptionId, scope: "current", enabled: null })}
					>
						{tx("stats.videoViews.followAll")}
					</Btn>
				) : null}
			</fieldset>
			{scope === "all" ? (
				<p className="text-center text-bn-xs text-bn-text-secondary">
					{tx("stats.videoViews.allHint")}
				</p>
			) : null}
		</>
	);
	return (
		<GlassPanel
			title={
				isVideo
					? tx("stats.videoViews.title", { name })
					: tx("sourceUi.pages.Stats.title.35", { value1: name })
			}
			subtitle={
				isVideo
					? tx("stats.videoViews.subtitle", { days })
					: tx("sourceUi.pages.Stats.subtitle.36", { value1: days })
			}
			accent={color}
			icon={isVideo ? <Icon.chart width={15} height={15} /> : <Icon.heart width={15} height={15} />}
			right={
				<fieldset
					className="min-w-0 shrink-0"
					aria-label={isVideo ? tx("stats.videoViews.grain") : tx("stats.followers.grain")}
				>
					<Picker
						value={grain}
						onChange={onGrainChange}
						options={[
							{ value: "hour", label: tx("stats.followers.hour") },
							{ value: "day", label: tx("stats.followers.day") },
						]}
					/>
				</fieldset>
			}
		>
			<fieldset className="mb-4" aria-label={tx("stats.videoViews.metric")}>
				<Picker
					value={metric}
					onChange={onMetricChange}
					options={[
						{ value: "followers", label: tx("stats.videoViews.followers") },
						{ value: "videoViews", label: tx("stats.videoViews.views") },
					]}
				/>
			</fieldset>
			{isVideo && (!supported || !enabled) ? (
				<div className="flex min-h-[250px] flex-col items-center justify-start gap-4 px-4 pb-4 text-center sm:pt-6">
					<Icon.chart size={28} className="text-bn-text-tertiary" />
					<p className="text-bn-base font-semibold text-bn-text-primary">
						{supported === false
							? tx("stats.videoViews.unsupported")
							: supported
								? tx("stats.videoViews.disabled")
								: tx("stats.videoViews.sourceUnavailable")}
					</p>
					{supported ? (
						<>
							<p className="max-w-lg text-bn-sm leading-relaxed text-bn-text-secondary">
								{tx("stats.videoViews.enableHint")}
							</p>
							{controls}
						</>
					) : null}
				</div>
			) : (
				<>
					{loading ? (
						<LoadingBlock
							variant="inset"
							className="h-[250px]"
							label={tx("sourceUi.pages.Stats.label.19")}
						/>
					) : isVideo && !hasVideoSamples ? (
						<div className="flex min-h-[250px] items-center justify-center px-4 text-center text-bn-sm text-bn-text-secondary">
							{video?.failure
								? video.failure.message
								: video?.active
									? tx("stats.videoViews.waiting")
									: tx("stats.videoViews.paused")}
						</div>
					) : (
						<ResponsiveChart
							height={250}
							render={(width) => (
								<TrendChart
									series={[
										{
											name: row.subscriptionId,
											color,
											data: isVideo
												? (video?.values ?? [])
												: grain === "day"
													? cumulativeFans(row)
													: (followersTrend?.rows.find(
															(one) => one.subscriptionId === row.subscriptionId,
														)?.values ?? []),
										},
									]}
									width={width}
									height={250}
									xLabels={
										isVideo && videoViewsTrend
											? followersTrendLabels(videoViewsTrend, width)
											: followersTrend
												? followersTrendLabels(followersTrend, width)
												: sparseLabels(dayAxis(days))
									}
									area
									absolute
									bridge
								/>
							)}
						/>
					)}
					{isVideo ? (
						<div className="mt-4 space-y-3">
							{controls}
							<p className="text-bn-xs text-bn-text-secondary">
								{tx("stats.videoViews.recordingHint")}
							</p>
							{video?.failure && hasVideoSamples ? (
								<ErrorNote>{video.failure.message}</ErrorNote>
							) : null}
							{!video?.active ? (
								<p className="text-bn-xs text-bn-text-secondary">{tx("stats.videoViews.paused")}</p>
							) : null}
						</div>
					) : grain === "hour" ? (
						<p className="mt-2 text-bn-xs text-bn-text-secondary">
							{tx("stats.followers.hourHint")}
						</p>
					) : null}
				</>
			)}
			{save.isError && save.variables.id === row.subscriptionId ? (
				<ErrorNote>
					{tx("stats.videoViews.saveFailed", { reason: errorTextOf(save.error) })}
				</ErrorNote>
			) : null}
		</GlassPanel>
	);
}
