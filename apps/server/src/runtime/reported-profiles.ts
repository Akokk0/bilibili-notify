import {
	type CreatorProfileReport,
	createSerialQueue,
	type Disposable,
	type ImageRef,
	type Logger,
	type MessageBus,
	type SubscriptionReportDelivery,
	type SubscriptionReportValue,
} from "@bilibili-notify/internal";
import type { ImageWriter } from "../images/image-store.js";
import { statsFileKey } from "../stats/file-key.js";
import { followersSampleGapMs } from "../stats/followers-sample-gap.js";
import type { StatsRecorderCore } from "../stats/recorder.js";
import { createProfileCacheWriter, type ProfileCacheUpdate } from "./profile-cache.js";
import { checkSubscriptionAvatarBytes } from "./subscription-avatar.js";
import type { SubscriptionStateStore } from "./subscription-state-store.js";

export { PROFILES_CHANGED_COALESCE_MS } from "./profile-cache.js";

/**
 * 拓展报的资料更新落盘(ADR-0019 决策 7 / 49 / 62):bus 上 `subscription-reported` 里 `kind === "profile"`
 * 的那些,逐条写进它对上的每条订阅的资料缓存(`SubscriptionStateStore.cachedProfile`),头像存进图库、资料里放引用。
 *
 * - **给了哪格改哪格**:名字 / 粉丝数没给的保持原样;头像没给就沿用原来那张 —— 沿用也是「抄引用」,先 `keep`
 *   续期,图已经不在了就不留悬空的引用(头像格直接缺)。`refreshedAt` 每次都换 —— 它说的是「资料什么时候
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
	subscriptionState: SubscriptionStateStore;
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

/**
 * 两条收资料的路(总线上拓展报的、来源经 `ctx.reportProfile` 报的)共用的写法(各开一条):一条队 + 一个资料缓存写口:
 * 逐条订阅「还在不在 → 写缓存」,攒下变了的订阅 id,尾沿叫一次面板。差别(头像怎么来、写完还做什么)由调用方给。
 */
interface ReportLane extends Disposable {
	/** 排上一条处理。一条抛了不许卡住后面的(写道自己保证);关门之后交进来的被拒,也只记一句。 */
	enqueue(task: () => Promise<void>, onError: (err: unknown) => void): void;
	/**
	 * 对 `ids` 里还在的订阅逐条写资料缓存(`updateOf` 现造这一条的更新),回写成了的订阅 id。
	 * 关停的 stop 段之后不再处理剩下的;变了的订阅 id 攒进合并窗口叫面板。
	 */
	writeEach(
		ids: Iterable<string>,
		updateOf: (id: string) => Promise<ProfileCacheUpdate>,
		after?: (id: string) => void,
	): Promise<string[]>;
	idle(): Promise<void>;
	close(): Promise<void>;
}

function createReportLane(opts: {
	bus: MessageBus;
	subscriptionState: SubscriptionStateStore;
	images: Pick<ImageWriter, "keep">;
	subscriptionIds: () => Iterable<string>;
	logger: Logger;
	coalesceMs?: number;
}): ReportLane {
	const log = opts.logger;
	const queue = createSerialQueue();
	let disposed = false;
	const cache = createProfileCacheWriter({
		bus: opts.bus,
		subscriptionState: opts.subscriptionState,
		images: opts.images,
		logger: opts.logger,
		coalesceMs: opts.coalesceMs,
	});

	return {
		enqueue(task, onError) {
			queue.run(WRITE_KEY, task).catch(onError);
		},
		async writeEach(ids, updateOf, after) {
			const alive = new Set(opts.subscriptionIds());
			const written: string[] = [];
			const changed: string[] = [];
			for (const id of ids) {
				if (disposed) return written;
				if (!alive.has(id)) {
					log.debug(`[sub-profile] 订阅 ${id} 已经不在了,它的资料更新不落盘`);
					continue;
				}
				try {
					if (await cache.write(id, await updateOf(id))) changed.push(id);
					written.push(id);
					after?.(id);
				} catch (err) {
					log.warn(`[sub-profile] 订阅 ${id} 的资料没写进去: ${String(err)}`);
				}
			}
			if (!disposed) cache.announce(changed);
			return written;
		},
		idle: () => queue.flush(),
		close: () => queue.close(),
		dispose() {
			disposed = true;
			cache.dispose();
		},
	};
}

export function bindReportedProfiles(opts: BindReportedProfilesOptions): ReportedProfilesHandle {
	const log = opts.logger;
	const lane = createReportLane(opts);

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

	async function apply(delivery: SubscriptionReportDelivery): Promise<void> {
		if (delivery.report.kind !== "profile") return;
		const value: ProfileValue = delivery.report.value;
		await lane.writeEach(delivery.subscriptionIds, async (id) => {
			const avatar =
				value.avatar === undefined ? undefined : await storeReportedAvatar(id, value.avatar);
			return { name: value.name, avatar, followers: value.fans };
		});
	}

	const sub = opts.bus.on("subscription-reported", (delivery) => {
		if (delivery.report.kind !== "profile") return;
		lane.enqueue(
			() => apply(delivery),
			(err) => log.warn(`[sub-profile] 处理一条资料更新时抛了: ${String(err)}`),
		);
	});

	return {
		idle: () => lane.idle(),
		close: () => lane.close(),
		dispose() {
			sub.dispose();
			lane.dispose();
		},
	};
}

export interface ProfileReportHandlerOptions {
	bus: MessageBus;
	subscriptionState: SubscriptionStateStore;
	/** 图库的续期口(沿用旧头像要先 `keep`;新头像来源已经存好了,这里不再存图)。 */
	images: Pick<ImageWriter, "keep">;
	/** 此刻还在的订阅 id(两支都算),**现取**。 */
	subscriptionIds: () => Iterable<string>;
	/** 统计记录器的两个口:粉丝数按间隔稀释记样本、记「这个小时拉过资料」。统计开关由记录器自己拦。 */
	recorder: Pick<StatsRecorderCore, "recordActive" | "recordReportedFollowers">;
	/** 资料刷新的 cron(`globals.profileRefreshCron`,现取):粉丝样本不密过它。 */
	profileRefreshCron: () => string;
	/**
	 * 写完当场叫资料刷新重算面板上这几行(`ProfileRefreshHandle.refreshReportedEntries`)。资料刷新在
	 * 开机的更后面才建,所以这里是个现取的转发;还没建好就什么都不做(那时面板还没有快照可更新)。
	 */
	refreshReportedEntries: (subscriptionIds: readonly string[]) => Promise<void>;
	logger: Logger;
	/** 测试用:合并窗口。默认 {@link PROFILES_CHANGED_COALESCE_MS}。 */
	coalesceMs?: number;
}

export interface ProfileReportHandler extends Disposable {
	/**
	 * 收一份来源经 `ctx.reportProfile` 报的资料。`subscriptionIds` 是宿主按身份展开、已挡掉停用的订阅;
	 * 排进同一条队串行处理,没有返回值。
	 */
	report(subscriptionIds: readonly string[], report: CreatorProfileReport): void;
	/** 队里已经排上的都处理完时落定。测试用。 */
	idle(): Promise<void>;
	/** 关停的 flush 段调:等在途与已排队的写完再关门(次序理由同 {@link ReportedProfilesHandle.close})。 */
	close(): Promise<void>;
}

/**
 * 来源经 `ctx.reportProfile` 报的资料落盘:不听总线,由 `createSourceContext` 的 `profiles` 选项直接交进来。
 * 与拓展那条老路({@link bindReportedProfiles})写同一个资料缓存,队与写口是同一种写法(`createReportLane`,各开一条)、同一个「给了哪格改哪格」的口径。差别:
 * 头像已经是图库引用(来源先 `storeImage` 存好,这里不收字节);`followers` 原样放;停用的订阅宿主已挡掉。
 *
 * 写完每条还在的订阅,照拓展适配对资料上报做的事:有粉丝数就记「这个小时拉过资料」(`followers` 那一格),
 * 并按资料刷新的间隔稀释记粉丝样本;最后当场叫资料刷新重算这几行,面板不必等下一轮。
 */
export function createProfileReportHandler(
	opts: ProfileReportHandlerOptions,
): ProfileReportHandler {
	const log = opts.logger;
	const lane = createReportLane(opts);

	async function apply(ids: readonly string[], report: CreatorProfileReport): Promise<void> {
		const written = await lane.writeEach(
			ids,
			async () => ({
				name: report.name,
				...(report.avatar === undefined ? {} : { avatar: report.avatar }),
				...(report.bio === undefined ? {} : { bio: report.bio }),
				...(report.followers === undefined ? {} : { followers: report.followers }),
				...(report.fanClubName === undefined ? {} : { fanClubName: report.fanClubName }),
			}),
			(id) => {
				if (report.followers === undefined) return;
				const key = statsFileKey({ id });
				// 这个小时拉资料成功过(不管粉丝样本被不被稀释掉)。
				opts.recorder.recordActive(key, "followers");
				opts.recorder.recordReportedFollowers(
					key,
					report.followers,
					followersSampleGapMs(opts.profileRefreshCron()),
				);
			},
		);
		if (written.length > 0) await opts.refreshReportedEntries(written);
	}

	return {
		report(subscriptionIds, report) {
			lane.enqueue(
				() => apply(subscriptionIds, report),
				(err) => log.warn(`[sub-profile] 处理一条资料上报时抛了: ${String(err)}`),
			);
		},
		idle: () => lane.idle(),
		close: () => lane.close(),
		dispose: () => lane.dispose(),
	};
}
