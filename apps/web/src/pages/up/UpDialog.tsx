import {
	AddButton,
	Avatar,
	Btn,
	ConfirmDialog,
	EmptyNote,
	HintNote,
	Icon,
	IconButton,
	ModalShell,
	PlatformIcon,
	Toggle,
} from "@bilibili-notify/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { TInput } from "../../components/forms";
import {
	DEFAULT_FEATURE_FLAGS,
	EXTRA_KEYS,
	type ExtraKey,
	FEATURE_KEYS,
	FEATURE_LABELS,
	type FeatureKey,
	isBiliSubscription,
	PUSH_EXTRAS,
	type PushTarget,
	type Subscription,
} from "../../types/domain";
import {
	displayName,
	targetsById as makeTargetsById,
	platformSupportsAtAll,
	routingAlignedToFeatures,
	subscriptionColor,
} from "./helpers";

const FEATURE_GROUPS: ReadonlyArray<{
	label: string;
	keys: ReadonlyArray<{ key: FeatureKey; sub?: string }>;
}> = [
	{
		label: "动态",
		keys: [{ key: "dynamic", sub: "投稿 / 转发 / 专栏" }],
	},
	{
		label: "直播",
		keys: [
			{ key: "live", sub: "开播提醒" },
			{ key: "liveEnd", sub: "下播卡片;词云 / AI 总结跟着它走" },
			{ key: "liveGuardBuy", sub: "舰长 / 提督 / 总督" },
			{ key: "superchat", sub: "Super Chat 提醒" },
		],
	},
	{
		label: "特别关注",
		keys: [
			{ key: "specialDanmaku", sub: "特别关注用户的弹幕" },
			{ key: "specialUserEnter", sub: "特别关注用户进直播间" },
		],
	},
];

/**
 * 挂在某把主特性那一行下面的附加项(ADR-0016:四把键一视同仁)。@全体 与下播的词云 /
 * 总结从这里起走同一段代码 —— 表由注册表自己说了算,加一把键不用回这个文件补分支。
 *
 * 三层:全局默认 + per-UP 覆盖 `overrides.features.extras.X`(两层合起来就是
 * {@link effExtra})+ per-target 三态表 `extras.X[targetId]`。「key ⊆ 主特性目标」由后端
 * schema 强制,所以主特性没给这个目标时这儿的开关一律禁用。
 *
 * 这个函数也是「关掉某把主特性的路由时,跟着作废哪几把覆写」的依据。
 */
function extrasUnder(feature: FeatureKey): ExtraKey[] {
	return EXTRA_KEYS.filter((k) => PUSH_EXTRAS[k].feature === feature);
}

/**
 * 每把附加项在面板上的一句说明。注册表里只放领域事实(挂哪、叫什么、默认值),界面措辞
 * 留在界面这一层;缺了也不炸 —— 新加的键先走兜底那句,补文案是另一回事。
 */
const EXTRA_HINTS: Partial<Record<ExtraKey, string>> = {
	atAllDynamic: "动态推送时附加 @全体",
	atAllLive: "开播推送时附加 @全体(SC / 上舰 / 词云 / 总结 不 @)",
	wordcloud: "下播时作为附加消息一起推",
	liveSummary: "下播时作为附加消息一起推",
};

function extraHint(k: ExtraKey): string {
	return EXTRA_HINTS[k] ?? `推送「${FEATURE_LABELS[PUSH_EXTRAS[k].feature]}」时附加一条`;
}

/** 主特性关着时的 tooltip —— 说清楚「先开哪个」,而不是干巴巴一句「不可用」。 */
function extraOffHint(k: ExtraKey): string {
	return `需先开启「${FEATURE_LABELS[PUSH_EXTRAS[k].feature]}」才能推这个附加项`;
}

export interface UpDialogProps {
	sub: Subscription | null;
	targets: PushTarget[];
	/**
	 * "edit"   — 现行行为:已有的 Subscription, 改 draft 后 onSave 触发 PATCH-like upsert。
	 * "create" — 新建模式:sub 是父组件构造的草稿(还没落盘),onSave 触发 POST。
	 *           按钮区:"移除订阅" 隐藏(还没创建);"保存配置" 即使 draft 未改也可点(因
	 *           为草稿本身就是「待提交的修改」);"取消" 关闭即丢弃,不调任何 API。
	 */
	mode?: "create" | "edit";
	/**
	 * 打开时滚到哪一节。`"targets"` = 推送目标 —— 无目标小卡上的「去配置」经 `/subs?open=`
	 * 跳过来时用;缺省从头开始。
	 */
	focusSection?: "targets";
	onClose: () => void;
	onSave: (next: Subscription) => void;
	onDelete: () => void;
	saving: boolean;
}

/**
 * Read sub's effective feature flag (override or inherit-default).
 */
/**
 * P2:稳定序列化(递归按 key 排序、跳过 undefined)。dirty 此前用裸
 * JSON.stringify 比较,对 key 序 / undefined 敏感 → 仅字段顺序不同即误判
 * dirty,关闭时假阳弹"丢弃未保存?"。与 subscription 包同策略。
 */
function stableStr(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStr).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj)
		.filter((k) => obj[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStr(obj[k])}`).join(",")}}`;
}

function effFeature(sub: Subscription, k: FeatureKey): boolean {
	return sub.overrides.features?.[k] ?? DEFAULT_FEATURE_FLAGS[k];
}

/** 附加项的生效值:per-UP 覆盖 ?? 全局默认。 */
function effExtra(sub: Subscription, k: ExtraKey): boolean {
	return sub.overrides.features?.extras?.[k] ?? DEFAULT_FEATURE_FLAGS.extras[k];
}

type FeaturesOverride = NonNullable<Subscription["overrides"]["features"]>;

/**
 * 把 features 覆盖收拾干净:附加项小对象空了就去掉,整个对象空了就是 undefined ——
 * 与默认值相同的开关不落 override,schema 里不留壳。
 */
function compactFeatures(f: FeaturesOverride): FeaturesOverride | undefined {
	const { extras, ...flags } = f;
	const kept = extras && Object.keys(extras).length > 0 ? extras : undefined;
	const out: FeaturesOverride = kept ? { ...flags, extras: kept } : flags;
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A target is in "custom" mode when its routing is **incomplete** —— 该 target 已被
 * 至少从一个 feature 的 routing 里手动剔除。完整(9 features 全在)= follow-mode。
 *
 * 注:features 总开关跟 routing **完全解耦**(由 runtime gate 兜底),所以这个判断
 * 跟 effFeature 无关。只看 routing 自己的「完整 / 残缺」即可。
 *
 * 不在任何 routing 里的 target 视为「未被订阅引用」,inferCustomSet 不收(单独由
 * sessionAttached 跟踪)。
 */
function inferCustomSet(sub: Subscription | null, targets: PushTarget[]): Set<string> {
	if (!sub) return new Set();
	const out = new Set<string>();
	for (const t of targets) {
		const referenced = FEATURE_KEYS.some((k) => sub.routing[k].includes(t.id));
		if (!referenced) continue;
		const incomplete = FEATURE_KEYS.some((k) => !sub.routing[k].includes(t.id));
		if (incomplete) out.add(t.id);
	}
	return out;
}

export function detachTargetFromDraft(d: Subscription, targetId: string): Subscription {
	const routing = { ...d.routing };
	for (const k of FEATURE_KEYS) {
		routing[k] = routing[k].filter((id) => id !== targetId);
	}
	let extras = d.extras;
	for (const k of EXTRA_KEYS) {
		if (targetId in extras[k]) {
			const { [targetId]: _gone, ...rest } = extras[k];
			extras = { ...extras, [k]: rest };
		}
	}
	return { ...d, routing, extras };
}

export function UpDialog({
	sub,
	targets,
	mode = "edit",
	onClose,
	onSave,
	onDelete,
	saving,
	focusSection,
}: UpDialogProps) {
	const [draft, setDraft] = useState<Subscription | null>(sub);
	const [customSet, setCustomSet] = useState<Set<string>>(() => inferCustomSet(sub, targets));
	// Targets the user attached during this dialog session — kept separately
	// from routing so a freshly-attached follow target still shows up even
	// while the user is mid-toggling the master feature switches (which is
	// when its routing entries can transiently be empty).
	const [sessionAttached, setSessionAttached] = useState<Set<string>>(new Set());
	const [showPicker, setShowPicker] = useState(false);
	// dirty 关闭时弹自定义「丢弃确认」对话框,替代浏览器原生 window.confirm。
	const [confirmingDiscard, setConfirmingDiscard] = useState(false);

	useEffect(() => {
		setDraft(sub);
		setCustomSet(inferCustomSet(sub, targets));
		setSessionAttached(new Set());
		setShowPicker(false);
		setConfirmingDiscard(false);
	}, [sub, targets]);

	const targetsByIdMap = useMemo(() => makeTargetsById(targets), [targets]);

	const attachedIds = useMemo(() => {
		const ids = new Set<string>(sessionAttached);
		if (draft) {
			for (const k of FEATURE_KEYS) for (const id of draft.routing[k]) ids.add(id);
		}
		return ids;
	}, [draft, sessionAttached]);

	const attachedTargets = useMemo(
		() => targets.filter((t) => attachedIds.has(t.id)),
		[targets, attachedIds],
	);
	const unattachedTargets = useMemo(
		() => targets.filter((t) => !attachedIds.has(t.id)),
		[targets, attachedIds],
	);

	// 「去配置」跳过来时滚到推送目标一节;别的打开方式从头开始。
	const targetsSectionRef = useRef<HTMLElement>(null);
	useEffect(() => {
		if (focusSection !== "targets") return;
		targetsSectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
	}, [focusSection]);

	if (!draft) return null;

	const color = subscriptionColor(draft);
	// create 模式下 draft 本身就是「待提交」,无论用户改没改字段都视为 dirty——保存按钮
	// 始终可点 + 关闭时一律走丢弃确认。
	const dirty = mode === "create" || (sub ? stableStr(sub) !== stableStr(draft) : false);

	function requestClose(): void {
		// 确认弹窗已开 → 交给它处理(ESC / 点遮罩),避免本函数重复触发。
		if (confirmingDiscard) return;
		if (dirty) {
			setConfirmingDiscard(true);
			return;
		}
		onClose();
	}

	function setEnabled(on: boolean): void {
		setDraft((d) => (d ? { ...d, enabled: on } : d));
	}

	function setNotes(value: string): void {
		setDraft((d) => (d ? { ...d, notes: value || undefined } : d));
	}

	function setGroups(value: string): void {
		const parts = value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		setDraft((d) => (d ? { ...d, groups: parts } : d));
	}

	/**
	 * Toggle a master feature on the subscription. **只写 `overrides.features`**,
	 * 不再级联 routing —— features 是 runtime 总开关,routing 是 per-target 细控,两条
	 * 正交轴。关 features.X 时 routing 数据原样保留;backend `BilibiliPush` 头部 gate
	 * `if (!eff.features[k]) return [];` 实际拦推送。重开 features.X 后,所有 routing
	 * 里的 target 立刻恢复推送,不丢配置。
	 *
	 * value === global default 时删 override,保持 schema 干净。
	 */
	function setFeatureEnabled(k: FeatureKey, on: boolean): void {
		setDraft((d) => {
			if (!d) return d;
			const { [k]: _drop, ...rest } = d.overrides.features ?? {};
			const next: FeaturesOverride = on === DEFAULT_FEATURE_FLAGS[k] ? rest : { ...rest, [k]: on };
			return { ...d, overrides: { ...d.overrides, features: compactFeatures(next) } };
		});
	}

	/**
	 * 附加项的 per-UP 值(@全体 / 词云 / AI 总结):只写 `overrides.features.extras.<k>`
	 * 那一个键,与全局默认相同就不落。它们没有自己的路由,跟着各自的主特性走。
	 */
	function setExtraEnabled(k: ExtraKey, on: boolean): void {
		setDraft((d) => {
			if (!d) return d;
			const cur = d.overrides.features ?? {};
			const { [k]: _drop, ...extras } = cur.extras ?? {};
			const nextExtras = on === DEFAULT_FEATURE_FLAGS.extras[k] ? extras : { ...extras, [k]: on };
			return {
				...d,
				overrides: {
					...d.overrides,
					features: compactFeatures({ ...cur, extras: nextExtras }),
				},
			};
		});
	}

	/**
	 * Pull a target into the subscription's push list. Follow-mode 默认 = 加进所有 9 个
	 * features 的 routing(features 总开关之后再单独控制是否实际推送)。这样用户
	 * 关掉某 feature 再开回来时,这个 target 不会被遗漏。
	 *
	 * 不再按 effFeature 过滤添加:routing 是「per-target 收哪些 feature」的意图表达,
	 * 跟 features 总开关解耦,新加 target 默认意图就是「全部都收」。
	 */
	function attachTarget(targetId: string): void {
		setDraft((d) => {
			if (!d) return d;
			let routing = d.routing;
			for (const k of FEATURE_KEYS) {
				if (!routing[k].includes(targetId)) {
					routing = { ...routing, [k]: [...routing[k], targetId] };
				}
			}
			return { ...d, routing };
		});
		setSessionAttached((prev) => {
			if (prev.has(targetId)) return prev;
			const next = new Set(prev);
			next.add(targetId);
			return next;
		});
	}

	/**
	 * Remove a target completely: clear all routing entries and any local
	 * mode/attachment bookkeeping. The user can re-attach via the picker.
	 */
	function detachTarget(targetId: string): void {
		setDraft((d) => {
			if (!d) return d;
			return detachTargetFromDraft(d, targetId);
		});
		setCustomSet((prev) => {
			if (!prev.has(targetId)) return prev;
			const next = new Set(prev);
			next.delete(targetId);
			return next;
		});
		setSessionAttached((prev) => {
			if (!prev.has(targetId)) return prev;
			const next = new Set(prev);
			next.delete(targetId);
			return next;
		});
	}

	/**
	 * Toggle one feature on a single target. Only ever invoked in custom mode
	 * (the UI does not show the per-feature toggles in follow mode).
	 *
	 * Side effect:关掉某把主特性时,同步把该 target 从它名下附加项的三态表里删掉
	 * ——schema 强制「附加项的 key ⊆ 主特性目标」,留着会 parse 失败。
	 */
	function toggleRouteForTarget(targetId: string, k: FeatureKey, on: boolean): void {
		setDraft((d) => {
			if (!d) return d;
			const list = d.routing[k];
			const has = list.includes(targetId);
			const next =
				on && !has ? [...list, targetId] : !on && has ? list.filter((id) => id !== targetId) : list;
			const routing = { ...d.routing, [k]: next };
			let extras = d.extras;
			if (!on) {
				for (const ek of extrasUnder(k)) {
					if (!(targetId in extras[ek])) continue;
					const { [targetId]: _gone, ...rest } = extras[ek];
					extras = { ...extras, [ek]: rest };
				}
			}
			return { ...d, routing, extras };
		});
	}

	/**
	 * 某个目标上某把附加项的显式覆写(写 extras.X Map)。主特性没给这个目标时不允许写 ——
	 * 后端 schema 那条「key ⊆ routing[主特性]」本来就不收。
	 * `explicit === undefined` 表示重置回跟随(删 Map key)。
	 */
	function setExtraExplicit(
		targetId: string,
		extraKey: ExtraKey,
		explicit: boolean | undefined,
	): void {
		setDraft((d) => {
			if (!d) return d;
			const feature = PUSH_EXTRAS[extraKey].feature;
			if (explicit !== undefined && !d.routing[feature].includes(targetId)) return d;
			const map = d.extras[extraKey];
			if (explicit === undefined) {
				if (!(targetId in map)) return d;
				const { [targetId]: _gone, ...rest } = map;
				return { ...d, extras: { ...d.extras, [extraKey]: rest } };
			}
			return {
				...d,
				extras: { ...d.extras, [extraKey]: { ...map, [targetId]: explicit } },
			};
		});
	}

	/**
	 * Flip a target between follow and custom mode.
	 * - To custom: routing 对齐订阅项生效特性(routingAlignedToFeatures)——「从跟随
	 *   订阅项现状起步」再由用户在矩阵里微调,而非默认全 9 项全开。
	 * - To follow: 把 target 加回所有 9 个 features 的 routing(完整 = follow 的标志);
	 *   per-target 的附加项显式覆写一并清掉,回归「跟订阅默认走」。
	 */
	function switchTargetMode(targetId: string, toCustom: boolean): void {
		setCustomSet((prev) => {
			const next = new Set(prev);
			if (toCustom) next.add(targetId);
			else next.delete(targetId);
			return next;
		});
		setDraft((d) => {
			if (!d) return d;
			let extras = d.extras;
			const clearExtras = (feature: FeatureKey): void => {
				for (const ek of extrasUnder(feature)) {
					if (!(targetId in extras[ek])) continue;
					const { [targetId]: _gone, ...rest } = extras[ek];
					extras = { ...extras, [ek]: rest };
				}
			};
			if (toCustom) {
				const routing = routingAlignedToFeatures(d, targetId);
				// 对齐时若把 target 移出某把主特性,它名下附加项的显式覆写一并作废。
				for (const k of FEATURE_KEYS) {
					if (!routing[k].includes(targetId)) clearExtras(k);
				}
				return { ...d, routing, extras };
			}
			let routing = d.routing;
			for (const k of FEATURE_KEYS) {
				if (!routing[k].includes(targetId)) {
					routing = { ...routing, [k]: [...routing[k], targetId] };
				}
			}
			// 切回 follow:per-target 的附加项显式覆写清掉,回归「跟订阅默认走」。
			for (const k of FEATURE_KEYS) clearExtras(k);
			return { ...d, routing, extras };
		});
	}

	function removeStaleId(id: string): void {
		setDraft((d) => {
			if (!d) return d;
			return detachTargetFromDraft(d, id);
		});
	}

	const staleIds = (() => {
		const set = new Set<string>();
		for (const k of FEATURE_KEYS)
			for (const id of draft.routing[k]) if (!targetsByIdMap.has(id)) set.add(id);
		return [...set];
	})();

	return (
		<ModalShell
			onCancel={requestClose}
			width={560}
			bodyClassName="flex max-h-[90vh] flex-col overflow-hidden"
		>
			{/* Cover header */}
			<div
				className="relative h-35 px-5 pb-4 pt-4"
				style={{
					background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 67%, transparent))`,
				}}
			>
				<IconButton
					icon={<Icon.close size={14} />}
					label="关闭"
					onClick={requestClose}
					size="lg"
					shape="pill"
					surface="scrim"
					className="absolute right-3.5 top-3.5"
				/>
				<div className="absolute -bottom-7 left-5 flex items-end gap-3">
					<Avatar
						name={displayName(draft)}
						color={color}
						size={64}
						url={draft.cachedProfile?.avatar}
						ring
					/>
					<div
						className="pb-2 text-bn-on-solid"
						style={{ textShadow: "0 1px 4px rgba(0,0,0,0.45)" }}
					>
						<div className="text-bn-md font-bold">{displayName(draft)}</div>
						<div
							className="mt-0.5 text-bn-xs font-semibold"
							style={{ color, textShadow: "0 1px 4px rgba(255,255,255,0.4)" }}
						>
							{/* 拓展订阅没有 uid(ADR-0019 决策 9)。 */}
							{isBiliSubscription(draft) ? (
								<span className="tabular-nums">UID {draft.uid}</span>
							) : null}
							{draft.cachedProfile?.fans != null ? (
								<>
									{isBiliSubscription(draft) ? <span className="mx-1 opacity-70">·</span> : null}
									<span>
										{draft.cachedProfile.fans >= 10_000
											? `${(draft.cachedProfile.fans / 10_000).toFixed(1)}万`
											: draft.cachedProfile.fans}{" "}
										粉丝
									</span>
								</>
							) : null}
						</div>
					</div>
				</div>
			</div>

			{/* Body */}
			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-5 pt-10">
				{/* 基础 */}
				<section>
					<SectionHeader label="基础" />
					<div className="overflow-hidden rounded-lg border border-bn-border bg-bn-surface">
						<BasicRow label="启用订阅" sub="关闭后整体停止接收推送">
							<Toggle value={draft.enabled} onChange={setEnabled} size="sm" />
						</BasicRow>
						<BasicRow label="分组" sub="多个分组以英文逗号分隔">
							<TInput
								ariaLabel="分组"
								width={160}
								value={draft.groups.join(",")}
								onChange={setGroups}
							/>
						</BasicRow>
						<BasicRow label="备注">
							<TInput ariaLabel="备注" width={160} value={draft.notes ?? ""} onChange={setNotes} />
						</BasicRow>
					</div>
				</section>

				{/* 订阅项总开关 */}
				<section>
					<SectionHeader label="订阅项 · 默认推送内容" />
					<p className="mb-2 text-bn-xs text-bn-text-secondary">
						这是该 UP 的"默认推送内容"。下方的推送目标若未单独自定义,会跟随这里的设置。
					</p>
					<div className="space-y-2">
						{FEATURE_GROUPS.map((g) => (
							<div
								key={g.label}
								className="overflow-hidden rounded-lg border border-bn-border bg-bn-surface"
							>
								<div className="border-b border-bn-border-subtle bg-bn-surface-muted px-3 py-1.5 text-bn-2xs font-bold uppercase tracking-wider text-bn-text-tertiary">
									{g.label}
								</div>
								<div className="grid grid-cols-2 gap-x-4 gap-y-2 px-3 py-2">
									{g.keys.map(({ key, sub: featSub }) => {
										const parentOn = effFeature(draft, key);
										return (
											<div key={key}>
												<FeatureToggleRow
													label={FEATURE_LABELS[key]}
													sub={featSub}
													value={parentOn}
													onChange={(on) => setFeatureEnabled(key, on)}
												/>
												<ExtraInlineToggles
													feature={key}
													parentOn={parentOn}
													value={(k) => effExtra(draft, k)}
													onChange={setExtraEnabled}
												/>
											</div>
										);
									})}
								</div>
							</div>
						))}
					</div>
				</section>

				{/* 推送目标 */}
				<section ref={targetsSectionRef}>
					<SectionHeader label="推送目标" />
					{targets.length === 0 ? (
						<EmptyNote size="sm">尚未配置任何推送目标 · 请先到「推送目标」页面创建</EmptyNote>
					) : (
						<div className="space-y-2">
							{attachedTargets.length === 0 ? (
								<EmptyNote size="sm">
									该订阅尚未指定推送目标 · 点击下方「添加推送目标」选择
								</EmptyNote>
							) : (
								attachedTargets.map((t) => (
									<TargetRoutingCard
										key={t.id}
										target={t}
										isCustom={customSet.has(t.id)}
										sub={draft}
										onToggleMode={(toCustom) => switchTargetMode(t.id, toCustom)}
										onToggleRoute={(k, on) => toggleRouteForTarget(t.id, k, on)}
										onSetExtra={(extraKey, explicit) => setExtraExplicit(t.id, extraKey, explicit)}
										onDetach={() => detachTarget(t.id)}
									/>
								))
							)}

							{/* Add-target picker */}
							{unattachedTargets.length > 0 ? (
								showPicker ? (
									<div className="rounded-lg border border-bn-border bg-bn-surface p-3">
										<div className="mb-1.5 flex items-center justify-between">
											<span className="text-bn-xs font-semibold text-bn-text-primary">
												选择要添加的推送目标
											</span>
											<button
												type="button"
												onClick={() => setShowPicker(false)}
												className="text-bn-xs text-bn-text-tertiary hover:text-bn-text-primary"
											>
												取消
											</button>
										</div>
										<div className="flex flex-wrap gap-1.5">
											{unattachedTargets.map((t) => (
												<AddButton
													key={t.id}
													className="bg-bn-surface"
													onClick={() => attachTarget(t.id)}
												>
													<Icon.plus size={11} />
													<PlatformIcon platform={t.platform} size={11} />
													<span className="max-w-35 truncate">{t.name}</span>
												</AddButton>
											))}
										</div>
									</div>
								) : (
									<AddButton block onClick={() => setShowPicker(true)}>
										<Icon.plus size={12} />
										添加推送目标 · 还有 {unattachedTargets.length} 个未添加
									</AddButton>
								)
							) : null}
						</div>
					)}
				</section>

				{/* Stale routing entries */}
				{staleIds.length > 0 ? (
					<section>
						<SectionHeader label="已失效的引用" />
						{/* 虚线警示旁注 —— 「引用落了空」,不是「操作失败」,所以不是 ErrorNote。 */}
						<HintNote tone="danger">
							<div className="mb-1.5">下列推送目标已被删除,但路由中仍有引用 · 点击移除</div>
							<div className="flex flex-wrap gap-1.5">
								{staleIds.map((id) => (
									<button
										type="button"
										key={id}
										onClick={() => removeStaleId(id)}
										data-bn="btn"
										className="inline-flex items-center gap-1.5 rounded-bn-pill border border-bn-danger-border bg-bn-surface px-2.5 py-1 text-bn-xs text-bn-danger hover:bg-bn-danger/10"
									>
										{id.slice(0, 8)} ×
									</button>
								))}
							</div>
						</HintNote>
					</section>
				) : null}
			</div>

			{/* Footer */}
			<div className="flex flex-col gap-1.5 border-t border-bn-border px-3.5 py-3">
				{attachedTargets.length === 0 && targets.length > 0 ? (
					<div className="flex items-start gap-1.5 rounded-md border border-bn-warning-border bg-bn-warning-soft px-2.5 py-1.5 text-bn-xs text-bn-warning-text">
						<Icon.warning size={12} className="mt-0.5 shrink-0" />
						<span>未选中任何推送目标,保存后该订阅不会向任何地方推送消息</span>
					</div>
				) : null}
				<div className="flex items-center gap-2">
					{mode === "edit" ? (
						<Btn
							variant="danger"
							size="sm"
							icon={<Icon.trash size={12} />}
							onClick={onDelete}
							disabled={saving}
						>
							移除订阅
						</Btn>
					) : null}
					<div className="flex-1" />
					<Btn variant="outline" size="sm" onClick={requestClose} disabled={saving}>
						取消
					</Btn>
					<Btn
						variant="primary"
						size="sm"
						onClick={() => {
							if (!dirty) {
								onClose();
								return;
							}
							onSave(draft);
						}}
						disabled={saving}
					>
						{saving
							? mode === "create"
								? "创建中…"
								: "保存中…"
							: mode === "create"
								? "创建订阅"
								: "保存配置"}
					</Btn>
				</div>
			</div>
			{confirmingDiscard ? (
				<ConfirmDialog
					title="丢弃未保存的修改?"
					message="你对这个订阅做的改动尚未保存,关闭后将丢失。"
					confirmLabel="丢弃"
					cancelLabel="继续编辑"
					danger
					onConfirm={onClose}
					onCancel={() => setConfirmingDiscard(false)}
				/>
			) : null}
		</ModalShell>
	);
}

// ── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
	return (
		<div className="mb-1.5 text-bn-2xs font-bold uppercase tracking-wider text-bn-text-tertiary">
			{label}
		</div>
	);
}

function BasicRow({
	label,
	sub,
	children,
}: {
	label: string;
	sub?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-3 border-b border-bn-border-subtle px-3 py-2.5 last:border-b-0">
			<div className="min-w-0 flex-1">
				<div className="text-bn-sm font-semibold text-bn-text-primary">{label}</div>
				{sub ? <div className="mt-0.5 text-bn-xs text-bn-text-secondary">{sub}</div> : null}
			</div>
			{children}
		</div>
	);
}

// ── Feature toggle row (used for both subscription master and target custom) ─

function FeatureToggleRow({
	label,
	sub,
	value,
	onChange,
}: {
	label: string;
	sub?: string;
	value: boolean;
	onChange: (on: boolean) => void;
}) {
	return (
		<div className="flex items-center gap-2.5">
			<Toggle value={value} onChange={onChange} size="sm" />
			<div className="min-w-0 flex-1">
				<div
					className={`text-bn-sm font-semibold ${
						value ? "text-bn-text-primary" : "text-bn-text-secondary"
					}`}
				>
					{label}
				</div>
				{sub ? (
					<div className="mt-0.5 truncate text-bn-2xs text-bn-text-secondary">{sub}</div>
				) : null}
			</div>
		</div>
	);
}

// ── 下播附加项 sub-toggles ───────────────────────────────────────────────────

/**
 * 下播下面的两个附加项(词云 / AI 总结),形制同 @全体 那一行:父项(下播)关着就
 * 整行灰掉、显示为关、点了不写。
 */
/**
 * 父订阅项下面那一行小开关:「+ 词云」「+ @全体」。父关着时整行变灰、开关禁用 ——
 * 附加项从来不能脱离本体单独发。三态覆写那一档(AtAllPerTargetToggle)不吃这个:
 * 它多一个「跟随默认」态、一颗重置钮和平台不支持的提示,揉进来只会让参数比正文长。
 */
function SubToggleRow({
	parentOn,
	value,
	onChange,
	label,
	hint,
	offHint,
	ariaLabel,
}: {
	parentOn: boolean;
	value: boolean;
	onChange: (on: boolean) => void;
	label: string;
	/** 父开着时的 tooltip。 */
	hint: string;
	/** 父关着时的 tooltip —— 说清楚「先开哪个」。 */
	offHint: string;
	ariaLabel?: string;
}) {
	return (
		<div
			className={`flex items-center gap-1.5 ${parentOn ? "text-bn-text-secondary" : "text-bn-text-disabled"}`}
			title={parentOn ? hint : offHint}
		>
			<Toggle
				value={parentOn && value}
				onChange={(on) => parentOn && onChange(on)}
				size="sm"
				disabled={!parentOn}
				{...(ariaLabel ? { ariaLabel } : {})}
			/>
			<span>+ {label}</span>
		</div>
	);
}

/**
 * per-UP 默认那一层的附加项开关(默认 panel 用):挂在该主特性那一行下面,一把键一行,
 * 一把都没有就整块不渲染。写 `overrides.features.extras.X`,作用于所有跟随态的目标。
 */
function ExtraInlineToggles({
	feature,
	parentOn,
	value,
	onChange,
}: {
	feature: FeatureKey;
	parentOn: boolean;
	value: (k: ExtraKey) => boolean;
	onChange: (k: ExtraKey, on: boolean) => void;
}) {
	const keys = extrasUnder(feature);
	if (keys.length === 0) return null;
	return (
		<div className="mt-0.5 ml-9 flex flex-col gap-1 text-bn-xs">
			{keys.map((k) => (
				<SubToggleRow
					key={k}
					parentOn={parentOn}
					value={value(k)}
					onChange={(on) => onChange(k, on)}
					label={PUSH_EXTRAS[k].label}
					// 带上所属主特性:@全体 在动态与开播下各有一枚,光一句「@全体」读屏分不清
					// 是哪一枚 —— 同一屏里两个同名控件,按名字找必然找错一个。
					ariaLabel={`${PUSH_EXTRAS[k].label} · ${FEATURE_LABELS[feature]}`}
					hint={extraHint(k)}
					offHint={extraOffHint(k)}
				/>
			))}
		</div>
	);
}

// ── per-target 三态 ──────────────────────────────────────────────────────────

/**
 * 某个推送目标自己的附加项开关(自定义 panel 矩阵用),三态:
 * - 显示值 = `explicit ?? inheritedValue`
 * - 点 Toggle = 切到 explicit 反向值(写 extras.X Map)
 * - explicit !== undefined 时旁边出 reset 图标(⟲),点击清掉 Map key = 重置为跟随
 * - parentOn=false(主特性没给这个目标)时整行 disabled —— 后端 schema 那条子集约束
 *   本来就不收,能点才是骗人
 * - unsupported 时强制禁用、显示为关、不出 reset,并在主特性已开时补一行说明。数据
 *   (extras.X Map)不动 —— 仅 UI 拦截,后端本就 best-effort 跳过。这一档只可能来自
 *   **平台能力**(今天只有 QQ 官机不支持 @全体),与配置面的三态是两回事。
 *
 * aria-label 带上目标名:一次能展开好几个目标,光一句「弹幕词云」读屏和测试都分不清
 * 是哪个群的。
 */
function ExtraPerTargetToggle({
	extraKey,
	targetName,
	parentOn,
	explicit,
	inheritedValue,
	unsupported,
	onSet,
}: {
	extraKey: ExtraKey;
	targetName: string;
	parentOn: boolean;
	explicit: boolean | undefined;
	inheritedValue: boolean;
	unsupported: boolean;
	onSet: (explicit: boolean | undefined) => void;
}) {
	const label = PUSH_EXTRAS[extraKey].label;
	const isExplicit = explicit !== undefined;
	const blocked = unsupported || !parentOn;
	const display = !unsupported && parentOn && (explicit ?? inheritedValue);
	const follow = `跟随订阅默认 · 当前 ${inheritedValue ? "ON" : "OFF"}`;
	const hint = unsupported
		? UNSUPPORTED_AT_ALL_NOTE
		: !parentOn
			? extraOffHint(extraKey)
			: isExplicit
				? `已显式设置为 ${explicit ? "ON" : "OFF"}(订阅默认为 ${inheritedValue ? "ON" : "OFF"})`
				: `${follow} · ${extraHint(extraKey)}`;
	return (
		<div className="mt-0.5 ml-9">
			<div
				className={`flex items-center gap-1.5 text-bn-xs ${blocked ? "text-bn-text-disabled" : "text-bn-text-secondary"}`}
				title={hint}
			>
				<Toggle
					value={display}
					onChange={(on) => !blocked && onSet(on)}
					size="sm"
					disabled={blocked}
					ariaLabel={`${label} · ${targetName}`}
				/>
				<span className={isExplicit && !unsupported ? "font-semibold text-bn-text-primary" : ""}>
					+ {label}
				</span>
				{isExplicit && parentOn && !unsupported ? (
					<IconButton
						icon={<Icon.refresh size={10} />}
						label={`重置 ${label} 为跟随订阅默认`}
						size="xs"
						onClick={() => onSet(undefined)}
					/>
				) : null}
			</div>
			{unsupported && parentOn ? (
				<div className="mt-0.5 text-bn-2xs text-bn-text-tertiary">{UNSUPPORTED_AT_ALL_NOTE}</div>
			) : null}
		</div>
	);
}

/** 平台不支持 @全体 时那一句 —— tooltip 与行下说明共用,别各写一份。 */
const UNSUPPORTED_AT_ALL_NOTE = "QQ 官方机器人不支持 @全体,发送时会自动跳过";

// ── Target routing card (master switch + collapsed details) ──────────────────

function TargetRoutingCard({
	target,
	isCustom,
	sub,
	onToggleMode,
	onToggleRoute,
	onSetExtra,
	onDetach,
}: {
	target: PushTarget;
	isCustom: boolean;
	sub: Subscription;
	onToggleMode: (toCustom: boolean) => void;
	onToggleRoute: (k: FeatureKey, on: boolean) => void;
	onSetExtra: (extraKey: ExtraKey, explicit: boolean | undefined) => void;
	onDetach: () => void;
}) {
	const enabledCount = isCustom
		? FEATURE_KEYS.filter((k) => sub.routing[k].includes(target.id)).length
		: FEATURE_KEYS.filter((k) => effFeature(sub, k)).length;

	return (
		<div className="overflow-hidden rounded-lg border border-bn-border bg-bn-surface">
			{/* Header */}
			<div className="flex items-center gap-2.5 px-3 py-2.5">
				<PlatformIcon platform={target.platform} size={16} />
				<div className="min-w-0 flex-1">
					<div className="truncate text-bn-sm font-semibold text-bn-text-primary">
						{target.name || "（未命名）"}
					</div>
					<div className="mt-0.5 text-bn-xs text-bn-text-secondary">
						{isCustom ? "自定义推送内容" : `跟随订阅项 · ${enabledCount} 项已开启`}
					</div>
				</div>
				{isCustom ? (
					<span className="text-bn-2xs tabular-nums text-bn-text-tertiary">
						{enabledCount}/{FEATURE_KEYS.length}
					</span>
				) : null}
				<Toggle value={isCustom} onChange={onToggleMode} size="sm" />
				<IconButton
					icon={<Icon.close size={11} />}
					label="移除该推送目标"
					size="md"
					tone="danger"
					shape="pill"
					onClick={onDetach}
				/>
			</div>

			{/* Detail (only when custom) */}
			{isCustom ? (
				<div className="border-t border-bn-border-subtle bg-bn-surface-muted">
					{FEATURE_GROUPS.map((g) => (
						<div
							key={g.label}
							className="border-b border-bn-border-subtle px-3 py-2 last:border-b-0"
						>
							<SectionHeader label={g.label} />
							<div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
								{g.keys.map(({ key, sub: featSub }) => {
									// 这一行下面挂的附加项由注册表说了算:动态 / 开播是 @全体,下播是词云与 AI 总结。
									const parentOn = sub.routing[key].includes(target.id);
									return (
										<div key={key}>
											<FeatureToggleRow
												label={FEATURE_LABELS[key]}
												sub={featSub}
												value={parentOn}
												onChange={(on) => onToggleRoute(key, on)}
											/>
											{extrasUnder(key).map((ek) => (
												<ExtraPerTargetToggle
													key={ek}
													extraKey={ek}
													targetName={target.name}
													parentOn={parentOn}
													explicit={
														Object.hasOwn(sub.extras[ek], target.id)
															? sub.extras[ek][target.id]
															: undefined
													}
													inheritedValue={effExtra(sub, ek)}
													// 要不要看平台能力由注册表说了算(别拿 label 判,那是文案)。
													unsupported={
														PUSH_EXTRAS[ek].capability === "atAll" &&
														!platformSupportsAtAll(target.platform)
													}
													onSet={(val) => onSetExtra(ek, val)}
												/>
											))}
										</div>
									);
								})}
							</div>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
