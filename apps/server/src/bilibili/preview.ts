/**
 * B 站来源的卡片页预览(`Source.fetchPreview`,4-14):作品那一支取这个人 space 动态列表里的第 `nth` 条,
 * 直播那一支在 `BiliLiveRooms.fetchPreview`。从前卡片路由自己拿着 B 站接口按 uid / 房间号取数,现在核心只问来源。
 *
 * 与真推送同一套:翻译走 `postFromDynamic`,配图、转发原作者头像、正文表情经 `ctx.fetchImage` 抓进图库;
 * 外层作者的头像由核心出卡时按订阅资料补(与推送一致)。链接不画在卡上,所以不按设置换 BV 号。
 * 不报问题、不改任何状态 —— 预览没有副作用。失败的原话会显示在面板上。
 */

import {
	fail,
	type Identity,
	type Logger,
	ok,
	type Post,
	type PreviewReport,
	type Result,
} from "@bilibili-notify/internal";
import { errorMessageOf } from "../util/error-message.js";
import type { Api } from "./api/index.js";
import { dynamicLink } from "./dynamic/dynamic-poller.js";
import { emojiUrlsOf, postFromDynamic, repostAvatarUrlOf } from "./dynamic/index.js";
import type { Dynamic } from "./dynamic/types.js";
import { failureFromBili } from "./error-codes.js";
import { t } from "./i18n.js";
import { fetchPostImages, type ImagesDeps } from "./images.js";

export interface BiliPostPreviewDeps {
	api: Pick<Api, "fetchUserSpaceDynamic">;
	/** 来源上下文的抓图口(图进图库「集成在途」那一家,与真推送同一条路)。 */
	images: ImagesDeps["images"];
	logger: Logger;
}

/** 作品卡的预览:这个人 space 动态列表里的第 `nth` 条(1 是最新那条)。 */
export async function previewBiliPost(
	identity: Identity,
	nth: number,
	deps: BiliPostPreviewDeps,
	signal: AbortSignal,
): Promise<Result<PreviewReport>> {
	let reply: unknown;
	try {
		reply = await deps.api.fetchUserSpaceDynamic(identity.externalId);
	} catch (error) {
		return fail("unavailable", errorMessageOf(error));
	}
	if (signal.aborted) return fail("indeterminate", "post preview request was aborted");
	const body =
		typeof reply === "object" && reply !== null ? (reply as Record<string, unknown>) : null;
	if (body === null || typeof body.code !== "number") {
		return fail("unavailable", t("bilibili.response.malformed"));
	}
	if (body.code !== 0) {
		const message =
			typeof body.message === "string" && body.message !== ""
				? body.message
				: t("bilibili.response.codeOnly", { code: body.code });
		return failureFromBili(body.code, message);
	}
	const data = body.data as { items?: unknown } | undefined;
	const items = Array.isArray(data?.items) ? (data.items as Dynamic[]) : [];
	if (items.length === 0) return fail("not_found", t("bilibili.preview.noPosts"));
	const item = items[nth - 1];
	if (!item) {
		return fail("not_found", t("bilibili.preview.nthOutOfRange", { nth, count: items.length }));
	}
	let post: Post;
	try {
		post = postFromDynamic(item);
	} catch (error) {
		return fail("invalid", t("bilibili.preview.untranslatable", { reason: errorMessageOf(error) }));
	}
	const withImages = await fetchPostImages(
		post,
		{ images: deps.images, logger: deps.logger },
		{ repostAvatarUrl: repostAvatarUrlOf(item), emojiUrls: emojiUrlsOf(item) },
	);
	return ok<PreviewReport>({
		kind: "post",
		report: {
			postId: item.id_str,
			url: dynamicLink(item, item.type === "DYNAMIC_TYPE_AV", false),
			post: withImages,
		},
	});
}
