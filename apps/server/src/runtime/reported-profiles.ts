import {
	type CreatorProfileReport,
	createSerialQueue,
	type Disposable,
	type Logger,
	type MessageBus,
} from "@bilibili-notify/internal";
import type { ImageWriter } from "../images/image-store.js";
import { statsFileKey } from "../stats/file-key.js";
import { followersSampleGapMs } from "../stats/followers-sample-gap.js";
import type { StatsRecorderCore } from "../stats/recorder.js";
import { createProfileCacheWriter, type ProfileCacheUpdate } from "./profile-cache.js";
import type { SubscriptionStateStore } from "./subscription-state-store.js";

export { PROFILES_CHANGED_COALESCE_MS } from "./profile-cache.js";

/**
 * 来源报的资料更新落盘(ADR-0019 决策 7 / 49 / 62):由 `createSourceContext` 的 `profiles` 选项直接交进来,
 * 逐条写进它对上的每条订阅的资料缓存(`SubscriptionStateStore.cachedProfile`)。
 *
 * - **给了哪格改哪格**:名字 / 资料格没给的保持原样;头像已经是图库引用,来源先存好图再交,这里不收字节。
 *   `refreshedAt` 每次都换 —— 它说的是「资料什么时候报过」。
 * - 停用的订阅不收(ctx 那头已经挡掉)。
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
	/** 关停的 flush 段调:等在途与已排队的写完再关门(次序理由同上)。 */
	close(): Promise<void>;
}

/**
 * 写完每条还在的订阅,照拓展适配对资料上报做的事:有粉丝数就记「这个小时拉过资料」(`followers` 那一格),
 * 并按资料刷新的间隔稀释记粉丝样本;最后当场叫资料刷新重算这几行,面板不必等下一轮。
 */
export function createProfileReportHandler(
	opts: ProfileReportHandlerOptions,
): ProfileReportHandler {
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

	async function writeEach(
		ids: Iterable<string>,
		updateOf: (id: string) => ProfileCacheUpdate,
	): Promise<string[]> {
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
				if (await cache.write(id, updateOf(id))) changed.push(id);
				written.push(id);
			} catch (err) {
				log.warn(`[sub-profile] 订阅 ${id} 的资料没写进去: ${String(err)}`);
			}
		}
		if (!disposed) cache.announce(changed);
		return written;
	}

	async function apply(ids: readonly string[], report: CreatorProfileReport): Promise<void> {
		const written = await writeEach(ids, () => ({
			name: report.name,
			...(report.avatar === undefined ? {} : { avatar: report.avatar }),
			...(report.bio === undefined ? {} : { bio: report.bio }),
			...(report.followers === undefined ? {} : { followers: report.followers }),
			...(report.fanClubName === undefined ? {} : { fanClubName: report.fanClubName }),
		}));
		if (report.followers !== undefined) {
			for (const id of written) {
				const key = statsFileKey({ id });
				// 这个小时拉资料成功过(不管粉丝样本被不被稀释掉)。
				opts.recorder.recordActive(key, "followers");
				opts.recorder.recordReportedFollowers(
					key,
					report.followers,
					followersSampleGapMs(opts.profileRefreshCron()),
				);
			}
		}
		if (written.length > 0) await opts.refreshReportedEntries(written);
	}

	return {
		report(subscriptionIds, report) {
			queue
				.run("reported-profiles", () => apply(subscriptionIds, report))
				.catch((err) => log.warn(`[sub-profile] 处理一条资料上报时抛了: ${String(err)}`));
		},
		idle: () => queue.flush(),
		close: () => queue.close(),
		dispose() {
			disposed = true;
			cache.dispose();
		},
	};
}
