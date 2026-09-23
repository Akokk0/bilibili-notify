import type {
	CachedProfile,
	Disposable,
	Logger,
	MessageBus,
	SubscriptionReportDelivery,
	SubscriptionReportValue,
} from "@bilibili-notify/internal";
import type { SubAvatarStore } from "./sub-avatar-store.js";
import type { SubRuntimeStore } from "./sub-runtime-store.js";

/**
 * 拓展报的资料更新落盘(ADR-0019 决策 7 / 49 / 62):bus 上 `subscription-reported` 里 `kind === "profile"`
 * 的那些,逐条写进它对上的每条订阅的资料缓存(`SubRuntimeStore.cachedProfile`),头像存成文件。
 *
 * - **给了哪格改哪格**:名字 / 粉丝数没给的保持原样;头像没给就留着原来那张。`lastRefreshedAt` 每次都换
 *   —— 它说的是「资料什么时候报过」。
 * - **头像摘要不同才覆盖**:同一张图再报一次,文件不重写、地址的 `?v=` 不变(头像仓自己判)。存不下来
 *   只记一句,名字与粉丝照样更新。
 * - 停用的订阅照样更新(ctx 那头已经把它们算进来了,决策 62:停用的也该有名字与头像)。
 * - 订阅刚删、拓展还没收到通知时报上来的:不再替它种资料、写头像 —— 删订阅那一刻的清理已经跑过了,
 *   这时写下去的就是孤儿,要等下次开机才扫得掉。
 * - 面板看得见的那几格真变了,才发 `subscription-profiles-changed`(按窗口合并),面板据此重取订阅列表。
 *
 * 处理**排成一条队**:两条资料交错着读改写同一条订阅,后落地的那条会把先落地那条改的格冲回去。
 */

/**
 * 「资料变了」合并的窗口:第一条变化起算,窗口里的变化在尾沿一起发一次,不因为又变了一条而往后推 ——
 * 与 `ctx.statusChanged()` 的合并窗口同一个数、同一个道理(`STATUS_CHANGED_COALESCE_MS`)。
 */
export const PROFILES_CHANGED_COALESCE_MS = 250;

export interface BindReportedProfilesOptions {
	bus: MessageBus;
	subRuntime: SubRuntimeStore;
	avatars: SubAvatarStore;
	/** 此刻还在的订阅 id(两支都算),**现取**。 */
	subscriptionIds: () => Iterable<string>;
	logger: Logger;
	/** 测试用:合并窗口。默认 {@link PROFILES_CHANGED_COALESCE_MS}。 */
	coalesceMs?: number;
}

export interface ReportedProfilesHandle extends Disposable {
	/** 队里已经排上的都处理完时落定。测试用。 */
	idle(): Promise<void>;
}

type ProfileValue = SubscriptionReportValue<"profile">;

/** 面板看得见的那几格变没变。 */
function visiblyChanged(prev: CachedProfile | undefined, next: CachedProfile): boolean {
	return prev?.name !== next.name || prev?.avatar !== next.avatar || prev?.fans !== next.fans;
}

export function bindReportedProfiles(opts: BindReportedProfilesOptions): ReportedProfilesHandle {
	const log = opts.logger;
	const windowMs = opts.coalesceMs ?? PROFILES_CHANGED_COALESCE_MS;
	let queue: Promise<void> = Promise.resolve();
	let disposed = false;
	/** 窗口里攒着的、变了的订阅 id。 */
	const pending = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;

	function announce(ids: readonly string[]): void {
		for (const id of ids) pending.add(id);
		if (timer !== undefined || pending.size === 0) return;
		timer = setTimeout(() => {
			timer = undefined;
			const changed = [...pending];
			pending.clear();
			opts.bus.emit("subscription-profiles-changed", changed);
		}, windowMs);
	}

	async function applyOne(id: string, value: ProfileValue): Promise<boolean> {
		let avatar: string | undefined;
		if (value.avatar !== undefined) {
			try {
				avatar = await opts.avatars.writeBytes(id, value.avatar);
			} catch (err) {
				log.warn(`[sub-profile] 订阅 ${id} 报来的头像没存下来,先留着原来那张: ${String(err)}`);
			}
		}
		const prev = opts.subRuntime.get(id)?.cachedProfile;
		const fans = value.fans ?? prev?.fans;
		const next: CachedProfile = {
			name: value.name ?? prev?.name ?? "",
			avatar: avatar ?? prev?.avatar ?? "",
			sign: prev?.sign ?? "",
			// 不知道就不写 —— 写 0 是在面板上印一句假话(同新建时种资料那条)。
			...(fans === undefined ? {} : { fans }),
			lastRefreshedAt: new Date().toISOString(),
		};
		await opts.subRuntime.patch(id, { cachedProfile: next });
		return visiblyChanged(prev, next);
	}

	async function apply(delivery: SubscriptionReportDelivery): Promise<void> {
		if (delivery.report.kind !== "profile") return;
		const value = delivery.report.value;
		const alive = new Set(opts.subscriptionIds());
		const changed: string[] = [];
		for (const id of delivery.subscriptionIds) {
			if (disposed) return;
			if (!alive.has(id)) {
				log.debug(`[sub-profile] 订阅 ${id} 已经不在了,它的资料更新不落盘`);
				continue;
			}
			try {
				if (await applyOne(id, value)) changed.push(id);
			} catch (err) {
				log.warn(`[sub-profile] 订阅 ${id} 的资料没写进去: ${String(err)}`);
			}
		}
		if (!disposed) announce(changed);
	}

	const sub = opts.bus.on("subscription-reported", (delivery) => {
		if (delivery.report.kind !== "profile") return;
		// 一条抛了不许卡住后面的:队尾永远是落定了的。
		queue = queue
			.then(() => apply(delivery))
			.catch((err) => log.warn(`[sub-profile] 处理一条资料更新时抛了: ${String(err)}`));
	});

	return {
		idle: () => queue,
		dispose() {
			disposed = true;
			sub.dispose();
			clearTimeout(timer);
			timer = undefined;
			pending.clear();
		},
	};
}
