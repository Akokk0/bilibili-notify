import {
	type CachedProfile,
	createSerialQueue,
	type Disposable,
	type ImageRef,
	type Logger,
	type MessageBus,
	type SubscriptionReportDelivery,
	type SubscriptionReportValue,
} from "@bilibili-notify/internal";
import type { ImageWriter } from "../images/image-store.js";
import { createKeyedCoalescer } from "../util/keyed-coalescer.js";
import type { SubRuntimeStore } from "./sub-runtime-store.js";
import { checkSubscriptionAvatarBytes } from "./subscription-avatar.js";

/**
 * 拓展报的资料更新落盘(ADR-0019 决策 7 / 49 / 62):bus 上 `subscription-reported` 里 `kind === "profile"`
 * 的那些,逐条写进它对上的每条订阅的资料缓存(`SubRuntimeStore.cachedProfile`),头像存进图库、资料里放引用。
 *
 * - **给了哪格改哪格**:名字 / 粉丝数没给的保持原样;头像没给就沿用原来那张 —— 沿用也是「抄引用」,先 `keep`
 *   续期,图已经不在了就不留悬空的引用(头像格直接缺)。`lastRefreshedAt` 每次都换 —— 它说的是「资料什么时候
 *   报过」。
 * - **同一张图再报一次引用不变**:图库按内容起名,面板的地址随之不变、浏览器的缓存照样命中。头像不合规矩
 *   (只收 png / jpeg / webp,约 96 KiB 封顶)或存不下来,只记一句,名字与粉丝照样更新、头像沿用原来那张。
 * - 停用的订阅照样更新(ctx 那头已经把它们算进来了,决策 62:停用的也该有名字与头像)。
 * - 订阅刚删、拓展还没收到通知时报上来的:不再替它种资料、存头像 —— 删订阅那一刻资料缓存已经丢了它,
 *   这时写下去的就是孤儿(头像由图库清扫收走,资料缓存里的条目要等下次开机才扫得掉)。
 * - 面板看得见的那几格真变了,才发 `subscription-profiles-changed`(按窗口合并),面板据此重取订阅列表。
 *
 * 处理**排成一条队**:两条资料交错着读改写同一条订阅,后落地的那条会把先落地那条改的格冲回去。
 *
 * 关停分两步:`dispose()`(stop 段)摘监听、置标记,在途那条的剩余订阅不再处理;`close()`(flush 段)
 * 等在途的那条把头像与资料缓存写完再关门。它往图库与资料缓存仓写,所以它的 `close()` 得排在那两家
 * 的 `close()` **之前**跑 —— 见 `bootstrap.ts` 的登记。
 */

/**
 * 「资料变了」合并的窗口:第一条变化起算,窗口里的变化在尾沿一起发一次,不因为又变了一条而往后推 ——
 * 与 `ctx.statusChanged()` 的合并窗口同一个数、同一个道理(`STATUS_CHANGED_COALESCE_MS`)。
 */
export const PROFILES_CHANGED_COALESCE_MS = 250;

export interface BindReportedProfilesOptions {
	bus: MessageBus;
	subRuntime: SubRuntimeStore;
	/** 图库的存图口(登记成引用方才拿得到,见 `bootstrap.ts`)。 */
	images: ImageWriter;
	/** 此刻还在的订阅 id(两支都算),**现取**。 */
	subscriptionIds: () => Iterable<string>;
	logger: Logger;
	/** 测试用:合并窗口。默认 {@link PROFILES_CHANGED_COALESCE_MS}。 */
	coalesceMs?: number;
}

export interface ReportedProfilesHandle extends Disposable {
	/** 队里已经排上的都处理完时落定。测试用。 */
	idle(): Promise<void>;
	/**
	 * 关停的 flush 段调:等队里在途与已排队的都处理完(它们写图库与资料缓存仓),再关门 ——
	 * 此后再来的资料不处理、不碰盘。先 `dispose()` 摘掉监听,才不会有新的进来。
	 */
	close(): Promise<void>;
}

type ProfileValue = SubscriptionReportValue<"profile">;

/** 写道的唯一一个键:所有资料更新排一队。 */
const WRITE_KEY = "reported-profiles";

/** 「资料变了」合并窗口的唯一一个键。 */
const CHANGED_KEY = "profiles-changed";

/** 面板看得见的那几格变没变。 */
function visiblyChanged(prev: CachedProfile | undefined, next: CachedProfile): boolean {
	return prev?.name !== next.name || prev?.avatar !== next.avatar || prev?.fans !== next.fans;
}

export function bindReportedProfiles(opts: BindReportedProfilesOptions): ReportedProfilesHandle {
	const log = opts.logger;
	const windowMs = opts.coalesceMs ?? PROFILES_CHANGED_COALESCE_MS;
	const queue = createSerialQueue();
	let disposed = false;
	/** 窗口里攒着的、变了的订阅 id。 */
	const pending = new Set<string>();
	/** 攒的是一整批订阅 id、到点一起发,所以合并器只有 {@link CHANGED_KEY} 这一个键。 */
	const changedWindow = createKeyedCoalescer({
		windowMs,
		onFire: () => {
			const changed = [...pending];
			pending.clear();
			opts.bus.emit("subscription-profiles-changed", { subscriptionIds: changed });
		},
	});

	function announce(ids: readonly string[]): void {
		for (const id of ids) pending.add(id);
		if (pending.size === 0) return;
		changedWindow.touch(CHANGED_KEY);
	}

	/** 这一轮报来的头像存进图库,回引用;不合规矩、存不下来都是 `undefined`(记一句,不让名字与粉丝跟着丢)。 */
	async function storeReportedAvatar(id: string, bytes: Uint8Array): Promise<ImageRef | undefined> {
		const checked = checkSubscriptionAvatarBytes(bytes);
		if (!checked.ok) {
			log.warn(`[sub-profile] 订阅 ${id} 报来的头像不收,先留着原来那张: ${checked.message}`);
			return undefined;
		}
		try {
			const stored = await opts.images.put(checked.bytes);
			if (stored.ok) return stored.ref;
			log.warn(`[sub-profile] 订阅 ${id} 报来的头像没存下来,先留着原来那张: ${stored.message}`);
		} catch (err) {
			log.warn(`[sub-profile] 订阅 ${id} 报来的头像没存下来,先留着原来那张: ${String(err)}`);
		}
		return undefined;
	}

	/**
	 * 沿用旧头像:抄引用,先续期。图已经不在了回 `undefined`(别把悬空的引用留在资料里);续期这一步本身出了错
	 * (不是「图不在」)就记一句、照旧沿用 —— 引用还在资料缓存里,清扫看得见它。
	 */
	async function carryOverAvatar(
		id: string,
		prev: ImageRef | undefined,
	): Promise<ImageRef | undefined> {
		if (prev === undefined) return undefined;
		try {
			return (await opts.images.keep(prev)) ? prev : undefined;
		} catch (err) {
			log.warn(`[sub-profile] 订阅 ${id} 原来的头像没能续期,照旧沿用: ${String(err)}`);
			return prev;
		}
	}

	async function applyOne(id: string, value: ProfileValue): Promise<boolean> {
		const prev = opts.subRuntime.get(id)?.cachedProfile;
		const avatar =
			(value.avatar === undefined ? undefined : await storeReportedAvatar(id, value.avatar)) ??
			(await carryOverAvatar(id, prev?.avatar));
		const fans = value.fans ?? prev?.fans;
		const next: CachedProfile = {
			name: value.name ?? prev?.name ?? "",
			// 没有头像就是这一格缺,不写空串。
			...(avatar === undefined ? {} : { avatar }),
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
		// 一条抛了不许卡住后面的(写道自己保证);关门之后交进来的被拒,也只记一句。
		queue
			.run(WRITE_KEY, () => apply(delivery))
			.catch((err) => log.warn(`[sub-profile] 处理一条资料更新时抛了: ${String(err)}`));
	});

	return {
		idle: () => queue.flush(),
		close: () => queue.close(),
		dispose() {
			disposed = true;
			sub.dispose();
			changedWindow.dispose();
			pending.clear();
		},
	};
}
