import { useEffect, useMemo, useState } from "react";
import { Avatar, Btn, PlatformIcon, Toggle } from "../../components/atoms";
import { ModalShell } from "../../components/dialog";
import { Icon } from "../../components/icons";
import {
	DEFAULT_FEATURE_FLAGS,
	FEATURE_KEYS,
	FEATURE_LABELS,
	type FeatureKey,
	type PushTarget,
	type Subscription,
} from "../../types/domain";
import { colorFromUid, displayName, targetsById as makeTargetsById } from "./helpers";

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
			{ key: "liveEnd", sub: "下播提醒" },
			{ key: "liveGuardBuy", sub: "舰长 / 提督 / 总督" },
			{ key: "superchat", sub: "Super Chat 提醒" },
			{ key: "wordcloud", sub: "弹幕词云" },
			{ key: "liveSummary", sub: "直播结束后 AI 总结" },
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
 * 哪些 feature 支持 @全体 修饰符。dynamic → atAll.dynamic;live → atAll.live(仅开播,
 * 不冲 liveEnd/SC/上舰/词云/总结)。两层:订阅级默认 `atAllDefaults.X` + per-target Map
 * 显式覆写 `atAll.X[targetId]`。`refine(keys(atAll.X) ⊆ routing.X)` 由后端强制。
 */
const AT_ALL_FEATURES: ReadonlyArray<{ feature: FeatureKey; scope: "dynamic" | "live" }> = [
	{ feature: "dynamic", scope: "dynamic" },
	{ feature: "live", scope: "live" },
];

type AtAllScope = "dynamic" | "live";

export interface UpDialogProps {
	sub: Subscription | null;
	targets: PushTarget[];
	onClose: () => void;
	onSave: (next: Subscription) => void;
	onDelete: () => void;
	saving: boolean;
}

/**
 * Read sub's effective feature flag (override or inherit-default).
 */
function effFeature(sub: Subscription, k: FeatureKey): boolean {
	return sub.overrides.features?.[k] ?? DEFAULT_FEATURE_FLAGS[k];
}

/**
 * A target is in "custom" mode when its routing diverges from the
 * subscription's effective features for at least one feature.
 *
 * Targets that aren't referenced by any routing entry are treated as
 * follow-mode (newly attached / never been individually customised).
 */
function inferCustomSet(sub: Subscription | null, targets: PushTarget[]): Set<string> {
	if (!sub) return new Set();
	const out = new Set<string>();
	for (const t of targets) {
		const referenced = FEATURE_KEYS.some((k) => sub.routing[k].includes(t.id));
		if (!referenced) continue;
		const mismatched = FEATURE_KEYS.some(
			(k) => effFeature(sub, k) !== sub.routing[k].includes(t.id),
		);
		if (mismatched) out.add(t.id);
	}
	return out;
}

export function UpDialog({ sub, targets, onClose, onSave, onDelete, saving }: UpDialogProps) {
	const [draft, setDraft] = useState<Subscription | null>(sub);
	const [customSet, setCustomSet] = useState<Set<string>>(() => inferCustomSet(sub, targets));
	// Targets the user attached during this dialog session — kept separately
	// from routing so a freshly-attached follow target still shows up even
	// while the user is mid-toggling the master feature switches (which is
	// when its routing entries can transiently be empty).
	const [sessionAttached, setSessionAttached] = useState<Set<string>>(new Set());
	const [showPicker, setShowPicker] = useState(false);

	useEffect(() => {
		setDraft(sub);
		setCustomSet(inferCustomSet(sub, targets));
		setSessionAttached(new Set());
		setShowPicker(false);
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

	if (!draft) return null;

	const color = colorFromUid(draft.uid);
	const dirty = sub ? JSON.stringify(sub) !== JSON.stringify(draft) : false;

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
	 * Toggle a master feature on the subscription. Writes to overrides.features
	 * (or clears the override when the new value matches the global default to
	 * keep the schema clean), then mirrors the change into routing for every
	 * attached follow-mode target. Unattached targets are left alone — the
	 * subscription should never silently start pushing to a target the user
	 * hasn't picked.
	 */
	function setFeatureEnabled(k: FeatureKey, on: boolean): void {
		setDraft((d) => {
			if (!d) return d;
			const overrideObj = { ...(d.overrides.features ?? {}) } as Record<string, boolean>;
			if (on === DEFAULT_FEATURE_FLAGS[k]) delete overrideObj[k];
			else overrideObj[k] = on;
			const features = Object.keys(overrideObj).length > 0 ? overrideObj : undefined;

			let routing = d.routing;
			for (const t of attachedTargets) {
				if (customSet.has(t.id)) continue;
				const inRouting = routing[k].includes(t.id);
				if (on && !inRouting) routing = { ...routing, [k]: [...routing[k], t.id] };
				else if (!on && inRouting)
					routing = { ...routing, [k]: routing[k].filter((id) => id !== t.id) };
			}

			return { ...d, overrides: { ...d.overrides, features }, routing };
		});
	}

	/**
	 * Pull a target into the subscription's push list. Starts in follow mode,
	 * so its routing snaps to whatever the master features currently say.
	 * Also recorded in sessionAttached so the card stays visible if the user
	 * subsequently turns every master feature off.
	 */
	function attachTarget(targetId: string): void {
		setDraft((d) => {
			if (!d) return d;
			let routing = d.routing;
			for (const k of FEATURE_KEYS) {
				const featOn = effFeature(d, k);
				if (featOn && !routing[k].includes(targetId)) {
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
			const routing = { ...d.routing };
			for (const k of FEATURE_KEYS) {
				routing[k] = routing[k].filter((id) => id !== targetId);
			}
			return { ...d, routing };
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
	 * Side effect:关掉 dynamic / live 时,同步把该 target 从对应 atAll.X Map 里删掉
	 * ——schema refine 强制 `keys(atAll.X) ⊆ routing.X`,留着会 parse 失败。
	 */
	function toggleRouteForTarget(targetId: string, k: FeatureKey, on: boolean): void {
		setDraft((d) => {
			if (!d) return d;
			const list = d.routing[k];
			const has = list.includes(targetId);
			const next =
				on && !has ? [...list, targetId] : !on && has ? list.filter((id) => id !== targetId) : list;
			const routing = { ...d.routing, [k]: next };
			let atAll = d.atAll;
			if (!on && (k === "dynamic" || k === "live")) {
				const scope = k;
				if (targetId in atAll[scope]) {
					const { [targetId]: _gone, ...rest } = atAll[scope];
					atAll = { ...atAll, [scope]: rest };
				}
			}
			return { ...d, routing, atAll };
		});
	}

	/** 订阅级默认 atAll 切换(在 "订阅项 · 默认推送内容" section 里使用)。 */
	function setAtAllDefault(scope: AtAllScope, on: boolean): void {
		setDraft((d) =>
			d ? { ...d, atAllDefaults: { ...d.atAllDefaults, [scope]: on } } : d,
		);
	}

	/**
	 * Per-target @全体 显式覆写(写 atAll.X Map)。父 feature 关闭时也不允许写。
	 * `explicit === undefined` 表示重置回 inherit(删 Map key)。
	 */
	function setAtAllExplicit(
		targetId: string,
		scope: AtAllScope,
		explicit: boolean | undefined,
	): void {
		setDraft((d) => {
			if (!d) return d;
			if (explicit !== undefined && !d.routing[scope].includes(targetId)) return d;
			const map = d.atAll[scope];
			if (explicit === undefined) {
				if (!(targetId in map)) return d;
				const { [targetId]: _gone, ...rest } = map;
				return { ...d, atAll: { ...d.atAll, [scope]: rest } };
			}
			return {
				...d,
				atAll: { ...d.atAll, [scope]: { ...map, [targetId]: explicit } },
			};
		});
	}

	/**
	 * Flip a target between follow and custom mode. Switching from custom to
	 * follow snaps the routing back in line with the subscription's effective
	 * features. Switching the other way leaves routing untouched so the user
	 * can edit per-feature.
	 */
	function switchTargetMode(targetId: string, toCustom: boolean): void {
		setCustomSet((prev) => {
			const next = new Set(prev);
			if (toCustom) next.add(targetId);
			else next.delete(targetId);
			return next;
		});
		if (!toCustom) {
			setDraft((d) => {
				if (!d) return d;
				let routing = d.routing;
				for (const k of FEATURE_KEYS) {
					const featOn = effFeature(d, k);
					const inRouting = routing[k].includes(targetId);
					if (featOn && !inRouting) routing = { ...routing, [k]: [...routing[k], targetId] };
					else if (!featOn && inRouting)
						routing = { ...routing, [k]: routing[k].filter((id) => id !== targetId) };
				}
				return { ...d, routing };
			});
		}
	}

	function removeStaleId(id: string): void {
		setDraft((d) => {
			if (!d) return d;
			const routing = { ...d.routing };
			for (const k of FEATURE_KEYS) {
				routing[k] = routing[k].filter((rid) => rid !== id);
			}
			return { ...d, routing };
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
			onCancel={onClose}
			width={560}
			bodyClassName=""
			bodyStyle={{
				maxHeight: "90vh",
				display: "flex",
				flexDirection: "column",
				overflow: "hidden",
			}}
		>
			{/* Cover header */}
			<div
				className="relative h-[140px] px-5 pb-4 pt-4"
				style={{ background: `linear-gradient(135deg, ${color}, ${color}aa)` }}
			>
				<button
					type="button"
					onClick={onClose}
					className="absolute right-3.5 top-3.5 grid h-7 w-7 place-items-center rounded-full bg-white/25 text-white backdrop-blur-sm"
					title="关闭"
				>
					<Icon.close size={14} />
				</button>
				<div className="absolute -bottom-7 left-5 flex items-end gap-3">
					<Avatar
						name={displayName(draft)}
						color={color}
						size={64}
						url={draft.cachedProfile?.avatar}
						ring
					/>
					<div className="pb-2 text-white" style={{ textShadow: "0 1px 4px rgba(0,0,0,0.45)" }}>
						<div className="text-base font-bold">{displayName(draft)}</div>
						<div
							className="mt-0.5 text-[11px] font-semibold"
							style={{ color, textShadow: "0 1px 4px rgba(255,255,255,0.4)" }}
						>
							<span className="font-mono">UID {draft.uid}</span>
							{draft.cachedProfile?.fans != null ? (
								<>
									<span className="mx-1 opacity-70">·</span>
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
					<div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
						<BasicRow label="启用订阅" sub="关闭后整体停止接收推送">
							<Toggle value={draft.enabled} onChange={setEnabled} size="sm" />
						</BasicRow>
						<BasicRow label="分组" sub="多个分组以英文逗号分隔">
							<input
								className="w-40 rounded border border-gray-200 px-1.5 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-bn-pink"
								value={draft.groups.join(",")}
								onChange={(e) => setGroups(e.target.value)}
							/>
						</BasicRow>
						<BasicRow label="备注">
							<input
								className="w-40 rounded border border-gray-200 px-1.5 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-bn-pink"
								value={draft.notes ?? ""}
								onChange={(e) => setNotes(e.target.value)}
							/>
						</BasicRow>
					</div>
				</section>

				{/* 订阅项总开关 */}
				<section>
					<SectionHeader label="订阅项 · 默认推送内容" />
					<p className="mb-2 text-[11px] text-bn-text-secondary">
						这是该 UP 的"默认推送内容"。下方的推送目标若未单独自定义,会跟随这里的设置。
					</p>
					<div className="space-y-2">
						{FEATURE_GROUPS.map((g) => (
							<div
								key={g.label}
								className="overflow-hidden rounded-lg border border-gray-200 bg-white"
							>
								<div className="border-b border-gray-100 bg-[#fafafa] px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-wider text-bn-text-tertiary">
									{g.label}
								</div>
								<div className="grid grid-cols-2 gap-x-4 gap-y-2 px-3 py-2">
									{g.keys.map(({ key, sub: featSub }) => {
										const atAllScope = AT_ALL_FEATURES.find((a) => a.feature === key)?.scope;
										const parentOn = effFeature(draft, key);
										return (
											<div key={key}>
												<FeatureToggleRow
													label={FEATURE_LABELS[key]}
													sub={featSub}
													value={parentOn}
													onChange={(on) => setFeatureEnabled(key, on)}
												/>
												{atAllScope ? (
													<AtAllInlineToggle
														value={draft.atAllDefaults[atAllScope]}
														parentOn={parentOn}
														scope={atAllScope}
														onChange={(on) => setAtAllDefault(atAllScope, on)}
													/>
												) : null}
											</div>
										);
									})}
								</div>
							</div>
						))}
					</div>
				</section>

				{/* 推送目标 */}
				<section>
					<SectionHeader label="推送目标" />
					{targets.length === 0 ? (
						<div className="rounded-md border border-dashed border-gray-200 px-3 py-3 text-center text-[11.5px] text-bn-text-secondary">
							尚未配置任何推送目标 · 请先到「推送目标」页面创建
						</div>
					) : (
						<div className="space-y-2">
							{attachedTargets.length === 0 ? (
								<div className="rounded-md border border-dashed border-gray-200 px-3 py-3 text-center text-[11.5px] text-bn-text-secondary">
									该订阅尚未指定推送目标 · 点击下方「添加推送目标」选择
								</div>
							) : (
								attachedTargets.map((t) => (
									<TargetRoutingCard
										key={t.id}
										target={t}
										isCustom={customSet.has(t.id)}
										sub={draft}
										onToggleMode={(toCustom) => switchTargetMode(t.id, toCustom)}
										onToggleRoute={(k, on) => toggleRouteForTarget(t.id, k, on)}
										onSetAtAll={(scope, explicit) => setAtAllExplicit(t.id, scope, explicit)}
										onDetach={() => detachTarget(t.id)}
									/>
								))
							)}

							{/* Add-target picker */}
							{unattachedTargets.length > 0 ? (
								showPicker ? (
									<div className="rounded-lg border border-gray-200 bg-white p-3">
										<div className="mb-1.5 flex items-center justify-between">
											<span className="text-[11.5px] font-semibold text-bn-text-primary">
												选择要添加的推送目标
											</span>
											<button
												type="button"
												onClick={() => setShowPicker(false)}
												className="text-[11px] text-bn-text-tertiary hover:text-bn-text-primary"
											>
												取消
											</button>
										</div>
										<div className="flex flex-wrap gap-1.5">
											{unattachedTargets.map((t) => (
												<button
													type="button"
													key={t.id}
													onClick={() => attachTarget(t.id)}
													className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-gray-300 bg-white px-2.5 py-1 text-[11.5px] text-bn-text-secondary hover:border-bn-pink hover:text-bn-pink"
												>
													<Icon.plus size={11} />
													<PlatformIcon platform={t.platform} size={11} />
													<span className="max-w-[140px] truncate">{t.name}</span>
												</button>
											))}
										</div>
									</div>
								) : (
									<button
										type="button"
										onClick={() => setShowPicker(true)}
										className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-300 bg-transparent px-3 py-2.5 text-[12px] text-bn-text-secondary hover:border-bn-pink hover:text-bn-pink"
									>
										<Icon.plus size={12} />
										添加推送目标 · 还有 {unattachedTargets.length} 个未添加
									</button>
								)
							) : null}
						</div>
					)}
				</section>

				{/* Stale routing entries */}
				{staleIds.length > 0 ? (
					<section>
						<SectionHeader label="已失效的引用" />
						<div className="rounded-md border border-dashed border-red-200 bg-red-50/50 px-3 py-2">
							<div className="mb-1.5 text-[11px] text-red-600">
								下列推送目标已被删除,但路由中仍有引用 · 点击移除
							</div>
							<div className="flex flex-wrap gap-1.5">
								{staleIds.map((id) => (
									<button
										type="button"
										key={id}
										onClick={() => removeStaleId(id)}
										className="inline-flex items-center gap-1.5 rounded-full border border-red-300 bg-white px-2.5 py-1 text-[11.5px] text-red-500 hover:bg-red-50"
									>
										{id.slice(0, 8)} ×
									</button>
								))}
							</div>
						</div>
					</section>
				) : null}
			</div>

			{/* Footer */}
			<div className="flex flex-col gap-1.5 border-t border-gray-200 px-3.5 py-3">
				{attachedTargets.length === 0 && targets.length > 0 ? (
					<div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
						⚠️ 未选中任何推送目标,保存后该订阅不会向任何地方推送消息
					</div>
				) : null}
				<div className="flex items-center gap-2">
					<Btn
						variant="danger"
						size="sm"
						icon={<Icon.trash size={12} />}
						onClick={onDelete}
						disabled={saving}
					>
						移除订阅
					</Btn>
					<div className="flex-1" />
					<Btn variant="outline" size="sm" onClick={onClose} disabled={saving}>
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
						{saving ? "保存中…" : "保存配置"}
					</Btn>
				</div>
			</div>
		</ModalShell>
	);
}

// ── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
	return (
		<div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-bn-text-tertiary">
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
		<div className="flex items-center gap-3 border-b border-gray-100 px-3 py-2.5 last:border-b-0">
			<div className="min-w-0 flex-1">
				<div className="text-[12.5px] font-semibold text-bn-text-primary">{label}</div>
				{sub ? <div className="mt-0.5 text-[11px] text-bn-text-secondary">{sub}</div> : null}
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
					className={`text-[12px] font-semibold ${
						value ? "text-bn-text-primary" : "text-bn-text-secondary"
					}`}
				>
					{label}
				</div>
				{sub ? (
					<div className="mt-0.5 truncate text-[10.5px] text-bn-text-secondary">{sub}</div>
				) : null}
			</div>
		</div>
	);
}

// ── @全体 sub-toggles ────────────────────────────────────────────────────────

/**
 * 订阅级默认 atAll toggle(默认 panel 用)。父 feature 关闭时 disabled。
 * 写 `Subscription.atAllDefaults.X`,作用于所有 inherit-state 的 target。
 */
function AtAllInlineToggle({
	value,
	parentOn,
	scope,
	onChange,
}: {
	value: boolean;
	parentOn: boolean;
	scope: AtAllScope;
	onChange: (on: boolean) => void;
}) {
	const hint =
		scope === "live"
			? "开播推送时附加 @全体(SC / 上舰 / 词云 / 总结 不 @)"
			: "动态推送时附加 @全体";
	return (
		<div
			className={`mt-0.5 ml-9 flex items-center gap-1.5 text-[11px] ${parentOn ? "text-bn-text-secondary" : "text-gray-300"}`}
			title={parentOn ? hint : "需先开启父订阅项才能 @全体"}
		>
			<Toggle
				value={parentOn && value}
				onChange={(on) => parentOn && onChange(on)}
				size="sm"
				disabled={!parentOn}
			/>
			<span>+ @全体</span>
		</div>
	);
}

/**
 * Per-target tristate @全体 toggle(自定义 panel 矩阵用)。
 * - 显示值 = `explicit ?? inheritedValue`
 * - 点 Toggle = 切到 explicit 反向值(写 atAll Map)
 * - explicit !== undefined 时旁边出 reset 图标(⟲),点击清掉 Map key = 重置为 inherit
 * - parentOn=false 时整行 disabled
 */
function AtAllPerTargetToggle({
	scope,
	parentOn,
	explicit,
	inheritedValue,
	onSet,
}: {
	scope: AtAllScope;
	parentOn: boolean;
	explicit: boolean | undefined;
	inheritedValue: boolean;
	onSet: (explicit: boolean | undefined) => void;
}) {
	const isExplicit = explicit !== undefined;
	const display = parentOn && (explicit ?? inheritedValue);
	const hint = !parentOn
		? "需先开启父订阅项才能 @全体"
		: isExplicit
			? `已显式设置为 ${explicit ? "ON" : "OFF"}(订阅默认为 ${inheritedValue ? "ON" : "OFF"})`
			: scope === "live"
				? `跟随订阅默认 · 当前 ${inheritedValue ? "ON" : "OFF"} · 仅开播 @,SC / 上舰 / 词云 / 总结 不 @`
				: `跟随订阅默认 · 当前 ${inheritedValue ? "ON" : "OFF"}`;
	return (
		<div
			className={`mt-0.5 ml-9 flex items-center gap-1.5 text-[11px] ${parentOn ? "text-bn-text-secondary" : "text-gray-300"}`}
			title={hint}
		>
			<Toggle
				value={display}
				onChange={(on) => parentOn && onSet(on)}
				size="sm"
				disabled={!parentOn}
			/>
			<span className={isExplicit ? "font-semibold text-bn-text-primary" : ""}>+ @全体</span>
			{isExplicit && parentOn ? (
				<button
					type="button"
					onClick={() => onSet(undefined)}
					aria-label="重置为跟随订阅默认"
					title="重置为跟随订阅默认"
					className="grid h-4 w-4 place-items-center rounded text-bn-text-tertiary hover:bg-gray-100 hover:text-bn-text-primary"
				>
					<Icon.refresh size={10} />
				</button>
			) : null}
		</div>
	);
}

// ── Target routing card (master switch + collapsed details) ──────────────────

function TargetRoutingCard({
	target,
	isCustom,
	sub,
	onToggleMode,
	onToggleRoute,
	onSetAtAll,
	onDetach,
}: {
	target: PushTarget;
	isCustom: boolean;
	sub: Subscription;
	onToggleMode: (toCustom: boolean) => void;
	onToggleRoute: (k: FeatureKey, on: boolean) => void;
	onSetAtAll: (scope: AtAllScope, explicit: boolean | undefined) => void;
	onDetach: () => void;
}) {
	const enabledCount = isCustom
		? FEATURE_KEYS.filter((k) => sub.routing[k].includes(target.id)).length
		: FEATURE_KEYS.filter((k) => effFeature(sub, k)).length;

	return (
		<div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
			{/* Header */}
			<div className="flex items-center gap-2.5 px-3 py-2.5">
				<PlatformIcon platform={target.platform} size={16} />
				<div className="min-w-0 flex-1">
					<div className="truncate text-[12.5px] font-semibold text-bn-text-primary">
						{target.name || "（未命名）"}
					</div>
					<div className="mt-0.5 text-[11px] text-bn-text-secondary">
						{isCustom ? "自定义推送内容" : `跟随订阅项 · ${enabledCount} 项已开启`}
					</div>
				</div>
				{isCustom ? (
					<span className="font-mono text-[10.5px] text-bn-text-tertiary">
						{enabledCount}/{FEATURE_KEYS.length}
					</span>
				) : null}
				<Toggle value={isCustom} onChange={onToggleMode} size="sm" />
				<button
					type="button"
					onClick={onDetach}
					aria-label="移除该推送目标"
					title="移除该推送目标"
					className="grid h-6 w-6 place-items-center rounded-full text-bn-text-tertiary hover:bg-red-50 hover:text-red-500"
				>
					<Icon.close size={11} />
				</button>
			</div>

			{/* Detail (only when custom) */}
			{isCustom ? (
				<div className="border-t border-gray-100 bg-[#fafafa]">
					{FEATURE_GROUPS.map((g) => (
						<div key={g.label} className="border-b border-gray-100 px-3 py-2 last:border-b-0">
							<div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-bn-text-tertiary">
								{g.label}
							</div>
							<div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
								{g.keys.map(({ key, sub: featSub }) => {
									// 仅 dynamic / live 行下方挂 "+ @全体" 子开关(tristate:explicit / inherit)。
									const atAllScope = AT_ALL_FEATURES.find((a) => a.feature === key)?.scope;
									const parentOn = sub.routing[key].includes(target.id);
									const explicit: boolean | undefined = atAllScope
										? Object.prototype.hasOwnProperty.call(sub.atAll[atAllScope], target.id)
											? sub.atAll[atAllScope][target.id]
											: undefined
										: undefined;
									const inheritedValue = atAllScope ? sub.atAllDefaults[atAllScope] : false;
									return (
										<div key={key}>
											<FeatureToggleRow
												label={FEATURE_LABELS[key]}
												sub={featSub}
												value={parentOn}
												onChange={(on) => onToggleRoute(key, on)}
											/>
											{atAllScope ? (
												<AtAllPerTargetToggle
													scope={atAllScope}
													parentOn={parentOn}
													explicit={explicit}
													inheritedValue={inheritedValue}
													onSet={(val) => onSetAtAll(atAllScope, val)}
												/>
											) : null}
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
