/**
 * 上舰卡的观众头像:上舰帧里没有头像,出卡前向 B 站查一次再抓进图库,卡上才画得出(3a-35)。
 *
 * 头像只是卡上的点缀:地址没有、接口失败 / 风控、抓不到都只是**这位观众没有头像**(头像块自己收起),
 * 卡照出、不退成文字、不抛。调用方在**确定要出卡时**才调(没渲染器 / 关了出图 / 被门槛挡掉的一次都不碰网络)。
 * 临时头像用引擎手里现成的抓图服务,引用方是「作品配图」那一家:不新开引用方,靠 24 小时宽限期回收。
 */

import type { ImageRef } from "@bilibili-notify/internal";
import type { Api } from "../api/index.js";
import { fetchAvatar, type ImagesDeps } from "../images";

/**
 * 上舰帧里没有头像:调一次 B 站接口(`fetchUserInfoInLive`)拿这位观众的头像地址,再抓进图库。
 * 接口失败、风控(`code` 非 0)、没给地址、抓不到都回 `undefined`(接口抛的记 warn),不抛。
 *
 * @param viewerId 观众的 uid。
 * @param upUid 主播的 uid(接口按「这位观众在这位主播的直播间」查)。
 */
export async function fetchGuardViewerAvatar(
	viewerId: string,
	upUid: string,
	api: Pick<Api, "fetchUserInfoInLive">,
	deps: ImagesDeps,
): Promise<ImageRef | undefined> {
	try {
		const response = await api.fetchUserInfoInLive(viewerId, upUid);
		// B 站回应里的头像地址字段是 `face`。
		const avatarUrl = response?.code === 0 ? response.data?.face : undefined;
		return typeof avatarUrl === "string" && avatarUrl !== ""
			? await fetchAvatar(avatarUrl, deps)
			: undefined;
	} catch (e) {
		deps.logger.warn(
			`[viewer-avatar] 查上舰观众的头像地址失败,这一张卡没有观众头像：${(e as Error).message}`,
		);
		return undefined;
	}
}
