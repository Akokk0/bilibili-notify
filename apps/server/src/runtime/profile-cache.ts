import type {
	CreatorProfile,
	Disposable,
	ImageRef,
	Logger,
	MessageBus,
} from "@bilibili-notify/internal";
import type { ImageWriter } from "../images/image-store.js";
import { createKeyedCoalescer } from "../util/keyed-coalescer.js";
import type { SubscriptionStateStore } from "./subscription-state-store.js";

/**
 * 两条路共用:拓展报的资料更新与以后资料刷新都写这一份缓存、都按同一套口径叫面板。
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
	/** 变了的订阅 id 攒进合并窗口,尾沿一起发一次 `subscription-profiles-changed`。 */
	announce(ids: readonly string[]): void;
}

/**
 * 「资料变了」合并的窗口:第一条变化起算,窗口里的变化在尾沿一起发一次,不因为又变了一条而往后推 ——
 * 与 `ctx.statusChanged()` 的合并窗口同一个数、同一个道理(`STATUS_CHANGED_COALESCE_MS`)。
 */
export const PROFILES_CHANGED_COALESCE_MS = 250;

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
	subscriptionState: SubscriptionStateStore;
	images: Pick<ImageWriter, "keep">;
	logger: Logger;
	coalesceMs?: number;
}): ProfileCacheWriter {
	const log = opts.logger;
	const windowMs = opts.coalesceMs ?? PROFILES_CHANGED_COALESCE_MS;
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
			log.warn(`[sub-profile] 订阅 ${id} 原来的头像没能续期,照旧沿用: ${String(err)}`);
			return prev;
		}
	}

	async function write(id: string, update: ProfileCacheUpdate): Promise<boolean> {
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
		await opts.subscriptionState.patch(id, { cachedProfile: next });
		return visiblyChanged(prev, next);
	}

	return {
		write,
		announce,
		dispose() {
			disposed = true;
			changedWindow.dispose();
			pending.clear();
		},
	};
}
