import {
	type Identity,
	type MessageBus,
	type Subscription,
	type SubscriptionOp,
	sameIdentity,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";

/**
 * 稳定序列化(递归按 key 排序)。P2:diff()/upsert 此前用裸 `JSON.stringify`
 * 比较,对 **key 插入序** 与 `undefined` 字段敏感 —— 语义相等的两份订阅(仅
 * 字段顺序不同 / 一边 `notes:undefined` 一边缺该键)被判为变更,emit 伪 update
 * op,engine 无谓 reconcile。排序 + 显式跳过 undefined 后比较即语义相等。
 */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj)
		.filter((k) => obj[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function sameSubscription(a: Subscription, b: Subscription): boolean {
	return stableStringify(a) === stableStringify(b);
}

/**
 * In-memory subscription collection with diff + emit.
 * Persistence is the caller's concern: the standalone runtime seeds from ConfigStore
 * and calls replaceAll() on load.
 */
export interface SubscriptionStore {
	/** Return a snapshot of all subscriptions (shallow copy). */
	list(): Subscription[];
	/**
	 * 按身份找订阅(ADR-0021 决策 14):来源与外部 id 两格都相等才算。同一个身份订了几条(老版本留下的
	 * 遗留重复,见 {@link findIdentityDuplicates})时取第一条;要全部的用 {@link listByIdentity}。
	 */
	findByIdentity(identity: Identity): Subscription | undefined;
	/** 这个身份底下的全部订阅,按列表里的先后;没有就是空数组。正常一条,老版本留下的遗留重复是多条。 */
	listByIdentity(identity: Identity): Subscription[];
	/** Find a subscription by its stable id; returns undefined if not found. */
	findById(id: string): Subscription | undefined;
	/**
	 * Insert or replace a subscription (match by id).
	 * Emits 'subscription-changed' with an add or update op.
	 */
	upsert(sub: Subscription): void;
	/**
	 * Remove a subscription by its stable id.
	 * Emits 'subscription-changed' with a remove op if found.
	 * Returns the removed subscription, or undefined if not found.
	 */
	removeById(id: string): Subscription | undefined;
	/**
	 * Replace the entire collection atomically.
	 * Computes the diff against the previous state and emits 'subscription-changed'
	 * with the resulting ops (may be empty if nothing changed).
	 */
	replaceAll(next: Subscription[]): void;
}

/** Compute an op list representing how prev → next changed (keyed by id). */
export function diff(prev: Subscription[], next: Subscription[]): SubscriptionOp[] {
	const ops: SubscriptionOp[] = [];
	const prevMap = new Map(prev.map((s) => [s.id, s]));
	const nextMap = new Map(next.map((s) => [s.id, s]));

	for (const [id, sub] of prevMap) {
		if (!nextMap.has(id)) ops.push({ kind: "remove", sub });
	}
	for (const [id, sub] of nextMap) {
		if (!prevMap.has(id)) {
			ops.push({ kind: "add", sub });
		} else {
			// 稳定比较:对 key 序 / undefined 不敏感,不再产伪 update op。
			const prev = prevMap.get(id);
			if (prev && !sameSubscription(prev, sub)) {
				ops.push({ kind: "update", sub });
			}
		}
	}
	return ops;
}

/** 认得出订的是谁的最小订阅形状:身份判重只看这两格。 */
type IdentifiedSubscription = Pick<Subscription, "id" | "identity">;

/** 同一身份底下不止一条的一组订阅。 */
export interface IdentityDuplicate<T extends IdentifiedSubscription = Subscription> {
	identity: Identity;
	/** 这个身份底下的订阅,按列表里的先后。 */
	subscriptions: T[];
}

/** 按身份分好的组。 */
interface IdentityGroups<T> {
	/** 各组,按第一次出现的先后。每组至少一条。 */
	groups: T[][];
	/** 这个身份底下的那组;没有就是 `undefined`。 */
	get(identity: Identity): T[] | undefined;
}

/** 按身份分组。两层 map(来源键 → 外部 id),身份不拼成字符串当键(见 docs/agents/subscriptions.md)。 */
function groupByIdentity<T extends IdentifiedSubscription>(subs: readonly T[]): IdentityGroups<T> {
	const index = new Map<string, Map<string, T[]>>();
	const groups: T[][] = [];
	for (const sub of subs) {
		const { sourceKey, externalId } = subscriptionIdentityOf(sub);
		let bySource = index.get(sourceKey);
		if (!bySource) {
			bySource = new Map();
			index.set(sourceKey, bySource);
		}
		const group = bySource.get(externalId);
		if (group) {
			group.push(sub);
			continue;
		}
		const created = [sub];
		bySource.set(externalId, created);
		groups.push(created);
	}
	return {
		groups,
		get: ({ sourceKey, externalId }) => index.get(sourceKey)?.get(externalId),
	};
}

function toDuplicate<T extends IdentifiedSubscription>(group: T[]): IdentityDuplicate<T> {
	return { identity: { ...subscriptionIdentityOf(group[0] as T) }, subscriptions: group };
}

/**
 * 列表里同一身份不止一条的那些。同一身份只能有一条订阅(docs/1.0/data-model.md),这里找出来的是
 * 老版本留下的遗留重复:开机照读,只记警告。
 */
export function findIdentityDuplicates<T extends IdentifiedSubscription>(
	subs: readonly T[],
): IdentityDuplicate<T>[] {
	return groupByIdentity(subs)
		.groups.filter((g) => g.length > 1)
		.map(toDuplicate);
}

/**
 * 从 `before` 写成 `after` **新增**了哪些重复:某个身份写之后的条数,比「1 与写之前的条数」里大的那个还多。
 *
 * 判据跟写之前比、不看整份有没有重复:盘上留着一对遗留重复时,改不相干的订阅、改那一对里的一条、删掉一条
 * 都照常能存;往那一对上再加第三条才算新增。所有写订阅的路径(新建、保存、恢复备份)都过这一道。
 */
export function findNewIdentityDuplicates<T extends IdentifiedSubscription>(
	before: readonly IdentifiedSubscription[],
	after: readonly T[],
): IdentityDuplicate<T>[] {
	const prior = groupByIdentity(before);
	return groupByIdentity(after)
		.groups.filter((g) => {
			const had = prior.get(subscriptionIdentityOf(g[0] as T))?.length ?? 0;
			return g.length > Math.max(1, had);
		})
		.map(toDuplicate);
}

/** Factory function producing an in-memory SubscriptionStore. */
export function createSubscriptionStore(bus: MessageBus): SubscriptionStore {
	let subs: Subscription[] = [];

	return {
		list() {
			return [...subs];
		},
		findByIdentity(identity) {
			return subs.find((s) => sameIdentity(subscriptionIdentityOf(s), identity));
		},
		listByIdentity(identity) {
			return subs.filter((s) => sameIdentity(subscriptionIdentityOf(s), identity));
		},
		findById(id) {
			return subs.find((s) => s.id === id);
		},
		upsert(sub) {
			const idx = subs.findIndex((s) => s.id === sub.id);
			if (idx !== -1) {
				// P2:内容未变则不发 update op(此前必发,engine 无谓 reconcile)。
				if (sameSubscription(subs[idx] as Subscription, sub)) return;
				subs = [...subs.slice(0, idx), sub, ...subs.slice(idx + 1)];
				bus.emit("subscription-changed", { ops: [{ kind: "update", sub }] });
				return;
			}
			subs = [...subs, sub];
			bus.emit("subscription-changed", { ops: [{ kind: "add", sub }] });
		},
		removeById(id) {
			const idx = subs.findIndex((s) => s.id === id);
			if (idx === -1) return undefined;
			const removed = subs[idx];
			subs = [...subs.slice(0, idx), ...subs.slice(idx + 1)];
			bus.emit("subscription-changed", { ops: [{ kind: "remove", sub: removed }] });
			return removed;
		},
		replaceAll(next) {
			const ops = diff(subs, next);
			subs = [...next];
			if (ops.length > 0) bus.emit("subscription-changed", { ops });
		},
	};
}

// Re-export types callers need from this package
export type { Subscription, SubscriptionOp };
