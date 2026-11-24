import {
	type ExtensionContext,
	type ExtensionPostReport,
	type ExtensionRichText,
	fail,
	ok,
	type Result,
} from "@bilibili-notify/extension";
import type { WeiboAccount } from "./account";
import { caption } from "./caption";
import { decimalId, HOME, record } from "./client";
import { image, imageUrl } from "./media";
import { postDetails } from "./post-details";

export function feedPost(value: unknown) {
	const row = record(value);
	const user = record(row.user);
	const uid = decimalId(user.idstr ?? user.id);
	const id = decimalId(row.idstr ?? row.mid ?? row.id);
	const time =
		typeof row.created_at === "string" &&
		/(?:Z$|\bGMT\b|\bUTC\b|[+-]\d{2}:?\d{2}\b)/i.test(row.created_at)
			? Date.parse(row.created_at)
			: NaN;
	if (!uid || !id || !Number.isFinite(time)) return;
	return { id, uid, time, row, user };
}

export type FeedPost = NonNullable<ReturnType<typeof feedPost>>;

function count(value: unknown) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function pictures(row: Record<string, unknown>) {
	const info = record(row.pic_infos);
	const ordered = Array.isArray(row.pic_ids)
		? row.pic_ids.map((id) => info[String(id)])
		: Object.values(info);
	return ordered.slice(0, 30).map((item) => {
		const picture = record(item);
		return record(
			picture.large ?? picture.largest ?? picture.original ?? picture.bmiddle ?? picture.thumbnail,
		).url;
	});
}

export async function postReport(
	ctx: ExtensionContext,
	account: WeiboAccount,
	{ uid, id, time, row, user }: FeedPost,
	signal: AbortSignal,
): Promise<Result<{ report: ExtensionPostReport }>> {
	const bid =
		typeof row.mblogid === "string" && /^[A-Za-z0-9]+$/.test(row.mblogid) ? row.mblogid : undefined;
	const url = bid ? `${HOME}${uid}/${bid}` : `${HOME}detail/${id}`;
	let expanded: ExtensionRichText | undefined;
	if (row.isLongText === true || row.isLongText === 1) {
		const detail = await account.get("/ajax/statuses/longtext", { id: bid ?? id }, signal, url);
		if (detail.ok) {
			const data = record(detail.data.data);
			for (const text of [data.longTextContent, data.longTextContent_raw]) {
				if (typeof text !== "string" || !text.trim()) continue;
				const parts = await caption(ctx, { ...row, ...data, text, text_raw: undefined }, signal);
				if (parts.length) {
					expanded = parts;
					break;
				}
			}
		} else if (detail.code !== "not_found") return detail;
	}
	const segments = expanded ?? (await caption(ctx, row, signal));
	const original = record(row.retweeted_status);
	const author = record(original.user).screen_name;
	if (typeof author === "string") {
		const quoted = await caption(ctx, original, signal);
		if (quoted.length)
			segments.push(
				{ kind: "text", text: `${segments.length ? "\n" : ""}//@${author}：` },
				...quoted,
			);
	}
	const post: ExtensionPostReport["post"] = {
		text: segments.map((segment) => segment.text).join(""),
		...(segments.some((segment) => segment.kind !== "text") && { richText: segments }),
		publishedAt: new Date(time).toISOString(),
		...(await postDetails(ctx, row, signal)),
		...(typeof user.screen_name === "string" && { creator: { name: user.screen_name } }),
	};
	const likes = count(row.attitudes_count),
		comments = count(row.comments_count),
		shares = count(row.reposts_count);
	if (likes !== undefined || comments !== undefined || shares !== undefined)
		post.stats = {
			...(likes !== undefined && { likes }),
			...(comments !== undefined && { comments }),
			...(shares !== undefined && { shares }),
		};
	const images = [];
	for (const value of pictures(row)) {
		const ref = await image(ctx, imageUrl(value), signal);
		if (ref) images.push(ref);
	}
	if (images.length) post.images = images;
	const page = record(row.page_info);
	if (page.object_type === "video" || record(page.media_info).media_type === "video") {
		const cover = await image(ctx, imageUrl(record(page.page_pic).url ?? page.page_pic), signal);
		post.video = {
			...(cover && { cover }),
			...(typeof page.page_title === "string" && { title: page.page_title }),
		};
	}
	if (signal.aborted) return fail("indeterminate", ctx.i18n.t("request.cancelled"));
	return ok({ report: { postId: id, url, post } });
}
