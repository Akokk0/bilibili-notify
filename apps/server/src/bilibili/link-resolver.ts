/**
 * B 站的链接解析器(群里贴了视频链接 → 查出视频 → 交一份作品与原生分享描述)。
 *
 * 由 B 站来源在 `start(ctx)` 里经 `ctx.registerLinkResolver` 登记(键就是来源的键);核心的门只管挑候选、
 * 问「认不认」、冷却、出卡与回复,不认识 B 站的网址、接口和小程序页面。
 *
 * 认的链接与「同一个视频」的判据见 `video-links.ts`;作品怎么翻见 `video-card.ts`。
 */

import {
	BILIBILI_SOURCE_KEY,
	fail,
	type LinkPreview,
	type LinkResolver,
	type Logger,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import { errorMessageOf } from "../util/error-message.js";
import type { Api, VideoRef, VideoResponse } from "./api/index.js";
import { fetchPostImages, type ImagesDeps } from "./images.js";
import { LINK_RESOLVER_TEXTS } from "./link-resolver-texts.js";
import { videoToPost } from "./video-card.js";
import { extractVideoLinks, type VideoLinkRef } from "./video-links.js";

export interface BiliLinkResolverDeps {
	/** 解析器的名字(给日志与面板用):由造它的人传,取来源描述符上的那个。 */
	label: string;
	api: Pick<Api, "fetchVideoInfo" | "resolveShortLink">;
	/** 抓图口(与推送的动态卡同一个 `ctx.fetchImage`):封面在交出作品前抓进图库,渲染页不联网,只有地址的图画不出来。 */
	fetchImage: ImagesDeps["images"]["fetchImage"];
	logger: Logger;
}

/** 已经带着视频号的那两种直接成形;短链还没解,给不出。 */
const directRef = (ref: VideoLinkRef): VideoRef | null =>
	ref.kind === "bvid" ? { bvid: ref.bvid } : ref.kind === "aid" ? { aid: ref.aid } : null;

/**
 * 原生分享(QQ 小程序卡)的中立描述,字段都来自视频信息。简介太长腾讯那边显示不下,截前 80 字;
 * 空的用 UP 名顶上 —— 卡上那行小字空着很难看。
 *
 * 页面路径是 B 站小程序的视频页:拿 B 站 App 真分享出来的卡向腾讯问 `GetAppInfoByLink`
 * 解出来的是 `pages/video/video?bvid=…&share_source=qq_ugc&unique_k=…`,后两个是统计
 * 参数,只带 bvid 真机验过能开(2026-09-07)。
 */
function nativeShareOf(info: VideoResponse): NonNullable<LinkPreview["nativeShare"]> {
	const desc = info.desc.trim().slice(0, 80);
	return {
		appId: BILIBILI_SOURCE_KEY,
		title: info.title,
		description: desc || info.owner.name,
		imageUrl: info.pic,
		pagePath: `pages/video/video?bvid=${info.bvid}`,
		webUrl: `https://www.bilibili.com/video/${info.bvid}`,
	};
}

export function createBiliLinkResolver(deps: BiliLinkResolverDeps): LinkResolver {
	async function toVideoRef(ref: VideoLinkRef): Promise<VideoRef | null> {
		if (ref.kind !== "short") return directRef(ref);
		const target = await deps.api.resolveShortLink(ref.url);
		if (!target) return null;
		const [resolved] = extractVideoLinks(target);
		return resolved ? directRef(resolved) : null;
	}

	return {
		label: deps.label,
		matches: (url) => extractVideoLinks(url).length > 0,
		async resolve(url): Promise<Result<LinkPreview>> {
			const [linkRef] = extractVideoLinks(url);
			if (!linkRef) return fail("not_found", LINK_RESOLVER_TEXTS.notVideoLink);
			try {
				const ref = await toVideoRef(linkRef);
				if (!ref) return fail("not_found", LINK_RESOLVER_TEXTS.shortLinkUnresolved);
				const info = await deps.api.fetchVideoInfo(ref);
				// 封面先抓进图库再交出作品;抓不到、抓图出错都不抛(那边记一条 warn),封面那一格没有引用。
				const post = await fetchPostImages(videoToPost(info), {
					images: { fetchImage: deps.fetchImage },
					logger: deps.logger,
				});
				// 规范 id 取 BV 号:av 号、带参数、移动端域名的写法落到同一个视频上。
				return ok({ post, canonicalId: info.bvid, nativeShare: nativeShareOf(info) });
			} catch (err) {
				// 接口失败(风控、网络、视频不存在)都收成失败结果;门静默。
				return fail("unavailable", errorMessageOf(err));
			}
		},
	};
}
