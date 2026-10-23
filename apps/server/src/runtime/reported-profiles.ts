import {
	createSerialQueue,
	type Disposable,
	type ImageRef,
	type Logger,
	type MessageBus,
	type SubscriptionReportDelivery,
	type SubscriptionReportValue,
} from "@bilibili-notify/internal";
import type { ImageWriter } from "../images/image-store.js";
import { createProfileCacheWriter } from "./profile-cache.js";
import type { SubRuntimeStore } from "./sub-runtime-store.js";
import { checkSubscriptionAvatarBytes } from "./subscription-avatar.js";

export { PROFILES_CHANGED_COALESCE_MS } from "./profile-cache.js";

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

export function bindReportedProfiles(opts: BindReportedProfilesOptions): ReportedProfilesHandle {
	const log = opts.logger;
	const queue = createSerialQueue();
	let disposed = false;
	const cache = createProfileCacheWriter({
		bus: opts.bus,
		subRuntime: opts.subRuntime,
		images: opts.images,
		logger: opts.logger,
		coalesceMs: opts.coalesceMs,
	});

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

	async function applyOne(id: string, value: ProfileValue): Promise<boolean> {
		const avatar =
			value.avatar === undefined ? undefined : await storeReportedAvatar(id, value.avatar);
		return cache.write(id, { name: value.name, avatar, fans: value.fans });
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
		if (!disposed) cache.announce(changed);
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
			cache.dispose();
		},
	};
}
