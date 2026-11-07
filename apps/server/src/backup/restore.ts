import {
	type Connection,
	type GlobalSettings,
	type PushTarget,
	type Subscription,
	type SubscriptionTag,
	sameIdentity,
} from "@bilibili-notify/internal";

/**
 * Restore planning — turns (current state + imported sections + mode) into a
 * flat set of write operations, as a pure function so the overwrite/merge
 * semantics are testable without touching the config store.
 *
 * - **overwrite**: the backup becomes the state. Each list scope replaces the
 *   current set (upsert everything in the backup, delete current entries the
 *   backup lacks). Globals and the integrations' settings are applied when the backup
 *   carries them.
 * - **merge**: additive only. Each list scope upserts the backup entries and
 *   deletes nothing. Globals are left untouched — merging someone's shared
 *   subscriptions must not clobber your own settings.
 *
 * A scope absent from the backup yields no writes for that scope in either mode.
 *
 * 订阅在两种模式下都先按 id 对、再按身份并入(见 {@link adoptLocalIds}):同一个人只能有一条订阅。订阅标签表跟着
 * 订阅那一节走(ADR-0034),合并时按 id、再按名字并(见 {@link planTags})。
 */

export type ImportMode = "overwrite" | "merge";

export interface CurrentState {
	globals: GlobalSettings;
	subscriptions: Subscription[];
	subscriptionTags: SubscriptionTag[];
	connections: Connection[];
	targets: PushTarget[];
}

export interface ImportSections {
	globals?: GlobalSettings;
	integrations?: Record<string, unknown>;
	extensionSettings?: Record<string, unknown>;
	subscriptions?: Subscription[];
	subscriptionTags?: SubscriptionTag[];
	connections?: Connection[];
	targets?: PushTarget[];
}

/** 折好的终态 —— ConfigStore.replaceSections 要的形状。 */
export interface FoldedSections {
	globals?: GlobalSettings;
	integrations?: Record<string, unknown>;
	extensionSettings?: Record<string, unknown>;
	subscriptions?: Subscription[];
	subscriptionTags?: SubscriptionTag[];
	connections?: Connection[];
	targets?: PushTarget[];
}

interface ScopePlan<T> {
	upsert: T[];
	delete: string[];
}

export interface ImportPlan {
	setGlobals?: GlobalSettings;
	/** 覆盖模式下备份带着的各集成的设置(整份换)。 */
	setIntegrations?: Record<string, unknown>;
	/** 覆盖模式下备份带着的各拓展的设置(带来的那几个整份换)。 */
	setExtensionSettings?: Record<string, unknown>;
	subscriptions: ScopePlan<Subscription>;
	/** 备份带着标签表时,恢复后的整张标签表(终态);没带就是 `undefined`,标签表不动。 */
	subscriptionTags?: SubscriptionTag[];
	connections: ScopePlan<Connection>;
	targets: ScopePlan<PushTarget>;
}

function planScope<T extends { id: string }>(
	current: T[],
	incoming: T[] | undefined,
	mode: ImportMode,
): ScopePlan<T> {
	if (!incoming) return { upsert: [], delete: [] };
	if (mode === "merge") return { upsert: incoming, delete: [] };
	const incomingIds = new Set(incoming.map((x) => x.id));
	const del = current.filter((x) => !incomingIds.has(x.id)).map((x) => x.id);
	return { upsert: incoming, delete: del };
}

/**
 * 恢复先按 id 对、再按身份并入(docs/1.0/data-model.md):备份里一行的 id 本机没有、身份却和本机某条一样,
 * 就当它是那一条 —— 换成本机的 id,内容用备份的(和按 id 对上的行一个口径)。统计、历史、锐评都挂在本机的
 * 订阅 id 上,备份不带这些,留本机的 id 它们才接得上。
 *
 * 按 id 已经对上的本机行不再拿来并;剩下的每条只认领一次,所以并完还剩的重复只可能是备份自己里面就有一对
 * (由 `service.ts` 拒收)。覆盖与合并两种模式都这样并:覆盖模式里并上的那条因此不会被当成「备份里没有」删掉。
 */
function adoptLocalIds(
	current: readonly Subscription[],
	incoming: readonly Subscription[],
): Subscription[] {
	const currentIds = new Set(current.map((s) => s.id));
	const incomingIds = new Set(incoming.map((s) => s.id));
	const unclaimed = current.filter((s) => !incomingIds.has(s.id));
	return incoming.map((row) => {
		if (currentIds.has(row.id)) return row;
		const idx = unclaimed.findIndex((s) => sameIdentity(s.identity, row.identity));
		if (idx < 0) return row;
		const [local] = unclaimed.splice(idx, 1);
		return { ...row, id: (local as Subscription).id };
	});
}

/**
 * 订阅标签(ADR-0034):覆盖模式整张用备份的。合并模式和订阅「先按 id 对、再按身份并入」一个思路 —— 先按 id 对
 * (同一个标签本机改过名,留本机的名字),再按名字对(名字就是主人眼里的这个标签,换成本机的 id),都对不上的接在
 * 本机那张后面、id 照用备份的(没按 id 对上,本机就没有这个 id)。回终态的标签表,以及「备份里的 id → 落地的 id」。
 */
function planTags(
	current: readonly SubscriptionTag[],
	incoming: readonly SubscriptionTag[],
	mode: ImportMode,
): { tags: SubscriptionTag[]; idMap: Map<string, string> } {
	if (mode === "overwrite") {
		return { tags: [...incoming], idMap: new Map(incoming.map((t) => [t.id, t.id])) };
	}
	const byId = new Map(current.map((t) => [t.id, t]));
	const byName = new Map(current.map((t) => [t.name, t]));
	const tags = [...current];
	const idMap = new Map<string, string>();
	for (const tag of incoming) {
		const local = byId.get(tag.id) ?? byName.get(tag.name);
		if (local) {
			idMap.set(tag.id, local.id);
			continue;
		}
		tags.push(tag);
		idMap.set(tag.id, tag.id);
		byId.set(tag.id, tag);
		byName.set(tag.name, tag);
	}
	return { tags, idMap };
}

/** 备份订阅上挂的标签换成落地的 id;几个落到同一个上的只挂一次。 */
function remapTagIds(
	subs: readonly Subscription[],
	idMap: ReadonlyMap<string, string>,
): Subscription[] {
	return subs.map((sub) => ({
		...sub,
		tagIds: [...new Set(sub.tagIds.map((id) => idMap.get(id) ?? id))],
	}));
}

export function planImport(
	current: CurrentState,
	incoming: ImportSections,
	mode: ImportMode,
): ImportPlan {
	const tagPlan =
		incoming.subscriptionTags &&
		planTags(current.subscriptionTags, incoming.subscriptionTags, mode);
	const incomingSubs =
		incoming.subscriptions && tagPlan
			? remapTagIds(incoming.subscriptions, tagPlan.idMap)
			: incoming.subscriptions;
	const subscriptions = incomingSubs && adoptLocalIds(current.subscriptions, incomingSubs);
	const plan: ImportPlan = {
		subscriptions: planScope(current.subscriptions, subscriptions, mode),
		subscriptionTags: tagPlan?.tags,
		connections: planScope(current.connections, incoming.connections, mode),
		targets: planScope(current.targets, incoming.targets, mode),
	};
	if (mode === "overwrite" && incoming.globals) plan.setGlobals = incoming.globals;
	// 各集成的设置与核心设置同一个口径:覆盖才换,合并不动主人自己的设置。按集成整份换,备份里没有的集成不动 ——
	// 集成是代码登记的,不是主人的数据:备份里缺了它,说明备份来自还没有它的版本,本机那份照留。空的这一节等于没带。
	if (
		mode === "overwrite" &&
		incoming.integrations &&
		Object.keys(incoming.integrations).length > 0
	) {
		plan.setIntegrations = incoming.integrations;
	}
	// 拓展的设置同一个口径:覆盖才换,带来的那几个整份换,没带的(备份之后才装的拓展)不动。
	const extensionSettings = incoming.extensionSettings;
	if (mode === "overwrite" && extensionSettings && Object.keys(extensionSettings).length > 0) {
		plan.setExtensionSettings = extensionSettings;
	}
	return plan;
}

function applyScope<T extends { id: string }>(
	current: readonly T[],
	plan: ScopePlan<T>,
): T[] | undefined {
	if (plan.upsert.length === 0 && plan.delete.length === 0) return undefined;
	const del = new Set(plan.delete);
	const next = current.filter((x) => !del.has(x.id));
	for (const item of plan.upsert) {
		const idx = next.findIndex((x) => x.id === item.id);
		if (idx < 0) next.push(item);
		else next[idx] = item;
	}
	return next;
}

/**
 * 把计划折成「这个分区最终应当是什么」。
 *
 * 恢复不是一串用户编辑,是一次整体替换 —— 所以 ConfigStore 那边要的是**终态**而不是
 * upsert/delete 序列。分区没有任何改动时返回 `undefined`,让它保持不动;返回空数组才是
 * 真清空(overwrite 模式下备份里给了空分区就是这个意思)。
 */
export function foldPlan(current: CurrentState, plan: ImportPlan): FoldedSections {
	return {
		globals: plan.setGlobals,
		integrations: plan.setIntegrations,
		extensionSettings: plan.setExtensionSettings,
		subscriptions: applyScope(current.subscriptions, plan.subscriptions),
		subscriptionTags: plan.subscriptionTags,
		connections: applyScope(current.connections, plan.connections),
		targets: applyScope(current.targets, plan.targets),
	};
}
