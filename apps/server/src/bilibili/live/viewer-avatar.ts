/**
 * 上舰卡的观众头像:上舰帧里没有头像,出卡前向 B 站查一次再抓进图库,卡上才画得出(3a-35)。
 *
 * 头像只是卡上的点缀:地址没有、接口失败 / 风控、抓不到都只是**这位观众没有头像**(头像块自己收起),
 * 卡照出、不退成文字、不抛。调用方在**确定要出卡时**才调(没渲染器 / 关了出图 / 被门槛挡掉的一次都不碰网络)。
 * 临时头像用推送链路手里现成的抓图服务,引用方是「作品配图」那一家:不新开引用方,靠 24 小时宽限期回收。
 *
 * 风控是账号级的:查头像撞到限流(`rate_limited`)之后,**所有直播间**在冷却期内都不再查,免得在风控期里
 * 还一条上舰敲一次门(3b-18,R1 乙)。冷却不报问题表 —— 头像是点缀,动态与直播预检两路已把风控报给主人。
 */

import type { ImageRef, Logger } from "@bilibili-notify/internal";
import type { Api } from "../api/index.js";
import { logText } from "../i18n.js";
import { fetchAvatar, type ImagesDeps } from "../images";

/** 撞到限流之后的冷却时长:这段时间里不查头像地址。 */
export const VIEWER_AVATAR_COOLDOWN_MS = 5 * 60 * 1000;

export interface ViewerAvatarFetcherDeps {
	api: Pick<Api, "fetchUserInfoInLive">;
	/** 抓图服务(只用抓远端图那一口)。 */
	images: ImagesDeps["images"];
	logger: Logger;
	now?: () => number;
}

export interface ViewerAvatarFetcher {
	/**
	 * 上舰帧里没有头像:调一次 B 站接口(`fetchUserInfoInLive`)拿这位观众的头像地址,再抓进图库。
	 * 接口失败、没给地址、抓不到、冷却中都回 `undefined`(接口抛的记 warn),不抛。
	 *
	 * @param viewerId 观众的 uid。
	 * @param upUid 主播的 uid(接口按「这位观众在这位主播的直播间」查)。
	 */
	fetch(viewerId: string, upUid: string): Promise<ImageRef | undefined>;
}

/** 全推送链路共用一个(冷却是账号级的状态,放不进自由函数):由 `RoomContext` 构造时建。 */
export function createViewerAvatarFetcher(deps: ViewerAvatarFetcherDeps): ViewerAvatarFetcher {
	const now = deps.now ?? Date.now;
	let cooldownUntil = 0;
	const imagesDeps: ImagesDeps = { images: deps.images, logger: deps.logger };

	return {
		async fetch(viewerId, upUid) {
			if (now() < cooldownUntil) return undefined;
			try {
				const result = await deps.api.fetchUserInfoInLive(viewerId, upUid);
				if (!result.ok) {
					if (result.code === "rate_limited") {
						// 同时在途的几次一起撞上时,只有第一个进冷却、记 warn;其余只是顺延。
						const alreadyCooling = now() < cooldownUntil;
						cooldownUntil = now() + VIEWER_AVATAR_COOLDOWN_MS;
						if (!alreadyCooling) {
							deps.logger.warn(logText("log.bilibili.live.avatarLimited"), {
								code: result.code,
								upstreamCode: result.upstreamCode,
								message: result.message,
								cooldownMs: VIEWER_AVATAR_COOLDOWN_MS,
							});
						}
					}
					// 别的失败(没登录、没对照的码、回应形状不对)只是这一张卡没有头像;没对照的码请求层已记过 warn。
					return undefined;
				}
				// B 站回应里的头像地址字段是 `face`。
				const avatarUrl = result.data?.face;
				return typeof avatarUrl === "string" && avatarUrl !== ""
					? await fetchAvatar(avatarUrl, imagesDeps)
					: undefined;
			} catch (e) {
				deps.logger.warn(logText("log.bilibili.live.avatarFailed"), { error: e });
				return undefined;
			}
		},
	};
}
