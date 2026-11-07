import {
	type CreatorProfile,
	createSerialQueue,
	type Disposable,
	type ImageRef,
	type Logger,
	type MessageBus,
	type Subscription,
} from "@bilibili-notify/internal";
import { logText } from "../i18n/index.js";
import type { ImageWriter } from "../images/image-store.js";
import { createKeyedCoalescer } from "../util/keyed-coalescer.js";
import type { SubscriptionStateStore } from "./subscription-state-store.js";

/**
 * 两条路共用:拓展报的资料更新与以后资料刷新都写这一份缓存、都按同一套口径叫面板;新建拓展订阅时种资料
 * 也经这里(`seed`,只在还没有资料时种)。全进程只有一个实例(`AppRuntime.profileCache`),写按订阅 id 串行;
 * 提交前现查订阅还在不在,删了的不写。
 *
 * - **给了哪格改哪格**:名字 / 头像 / 简介 / 粉丝数 / 粉丝团名没给的保持原样;头像没给就沿用原来那张 ——
 *   沿用也是「抄引用」,先 `keep` 续期,图已经不在了就不留悬空的引用(头像格直接缺)。
 *   `refreshedAt` 每次都换 —— 它说的是「资料什么时候报过」。
 * - 名字没给又没旧值时写空串;简介为空串时按缺键处理;粉丝数不知道就不写 —— 写 0 是在面板上印一句假话。
 * - B 站头像的来源网址住集成自己的状态,不写进核心资料缓存。
 * - 面板看得见的那几格真变了,才发 `subscription-profiles-changed`(按窗口合并),面板据此重取订阅列表。
 */

export interface ProfileCacheUpdate {
	name?: string;
	/** 已经存进图库的引用;没给 = 沿用旧的那张(先 keep 续期,图不在了就缺这一格)。 */
	avatar?: ImageRef;
	bio?: string;
	followers?: number;
	fanClubName?: string;
}

export interface ProfileCacheWriter extends Disposable {
	/** 把这一次并进这条订阅的资料缓存;回「面板看得见的那几格变没变」。 */
	write(id: string, update: ProfileCacheUpdate): Promise<boolean>;
	/**
	 * 新建订阅时种资料:与 {@link write} 排同一条队,轮到时这条订阅还没有资料才种 —— 拓展收到新建通知就先报了的,
	 * 不动它。`build` 只在要种时才跑(头像在里面存进图库,不种就不存);回种没种。
	 */
	seed(id: string, build: () => Promise<ProfileCacheUpdate>): Promise<boolean>;
	/** 变了的订阅 id 攒进合并窗口,尾沿一起发一次 `subscription-profiles-changed`。 */
	announce(ids: readonly string[]): void;
	/** 关停的 flush 段调:等在途与已排队的写完再关门。它往资料缓存仓写,得排在那家 `close()` 之前跑。 */
	close(): Promise<void>;
}

/**
 * 「资料变了」合并的窗口:第一条变化起算,窗口里的变化在尾沿一起发一次,不因为又变了一条而往后推 ——
 * 与 `ctx.statusChanged()` 的合并窗口同一个数、同一个道理(`STATUS_CHANGED_COALESCE_MS`)。
 */
const PROFILES_CHANGED_COALESCE_MS = 250;

/** 「资料变了」合并窗口的唯一一个键。 */
const CHANGED_KEY = "profiles-changed";

/** 面板看得见的那几格变没变。 */
function visiblyChanged(prev: CreatorProfile | undefined, next: CreatorProfile): boolean {
	return (
		prev?.name !== next.name || prev?.avatar !== next.avatar || prev?.followers !== next.followers
	);
}

export function createProfileCacheWriter(opts: {
	bus: MessageBus;
	subscriptionState: Pick<SubscriptionStateStore, "get" | "patch">;
	images: Pick<ImageWriter, "keep">;
	/**
	 * 此刻这条订阅还在不在(现查;宿主传 `configStore.getSubscription`)。提交前的那一眼与下面那一发
	 * `patch` 在同一个同步段:删订阅在前的这次不写,在后的它排的 prune 在 patch 之后跑。
	 */
	subscription: (id: string) => Subscription | undefined;
	logger: Logger;
	coalesceMs?: number;
}): ProfileCacheWriter {
	const log = opts.logger;
	const windowMs = opts.coalesceMs ?? PROFILES_CHANGED_COALESCE_MS;
	let disposed = false;
	/** 按订阅 id 串行:同一条订阅的两次写,后一次读到的一定是前一次写完的资料。 */
	const writes = createSerialQueue();
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
		if (disposed) return;
		for (const id of ids) pending.add(id);
		if (pending.size === 0) return;
		changedWindow.touch(CHANGED_KEY);
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
			log.warn(logText("log.profile.avatarKeepFailed"), { subscriptionId: id, error: err });
			return prev;
		}
	}

	async function commit(id: string, update: ProfileCacheUpdate): Promise<boolean> {
		const prev = opts.subscriptionState.get(id)?.cachedProfile;
		const avatar =
			update.avatar === undefined ? await carryOverAvatar(id, prev?.avatar) : update.avatar;
		const bio = update.bio === "" ? undefined : (update.bio ?? prev?.bio);
		const followers = update.followers ?? prev?.followers;
		const fanClubName = update.fanClubName ?? prev?.fanClubName;
		const next: CreatorProfile = {
			name: update.name ?? prev?.name ?? "",
			// 没有头像就是这一格缺,不写空串。
			...(avatar === undefined ? {} : { avatar }),
			...(bio === undefined ? {} : { bio }),
			// 不知道就不写 —— 写 0 是在面板上印一句假话(同新建时种资料那条)。
			...(followers === undefined ? {} : { followers }),
			...(fanClubName === undefined ? {} : { fanClubName }),
			refreshedAt: new Date().toISOString(),
		};
		// 栅栏:核订阅在不在与排进资料缓存仓的写队放在**同一个同步段**。删订阅在前 → 这次不写;
		// 删订阅在后 → 它排的 prune 在这次 patch 之后跑,刚写下的条目当场被清掉。
		if (opts.subscription(id) === undefined) return false;
		await opts.subscriptionState.patch(id, { cachedProfile: next });
		return visiblyChanged(prev, next);
	}

	return {
		write(id, update) {
			return writes.run(id, () => commit(id, update));
		},
		seed(id, build) {
			return writes.run(id, async () => {
				if (opts.subscription(id) === undefined) return false;
				if (opts.subscriptionState.get(id)?.cachedProfile !== undefined) return false;
				// 没有旧资料,`commit` 写下的就是 build 给的这几格;订阅在 build 途中被删了它回 false。
				return commit(id, await build());
			});
		},
		announce,
		async close() {
			disposed = true;
			changedWindow.dispose();
			pending.clear();
			await writes.close();
		},
		dispose() {
			disposed = true;
			changedWindow.dispose();
			pending.clear();
		},
	};
}
