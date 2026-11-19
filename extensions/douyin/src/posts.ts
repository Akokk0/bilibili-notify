import {
	type ExtensionContext,
	type ExtensionPostReport,
	type ExtensionRichText,
	fail,
	ok,
	type Result,
} from "@bilibili-notify/extension";
import { count, image, object, text } from "./media";
import type { DouyinSourceClient } from "./source";

function stamp(aweme: Record<string, unknown>) {
	const id = text(aweme.aweme_id);
	const time = count(aweme.create_time);
	if (!id || !/^\d+$/.test(id) || !time || time > 253402300799) return;
	return { id, time };
}

function captionTopics(caption: string, fields: unknown): ExtensionRichText | undefined {
	if (!caption || !Array.isArray(fields)) return;
	// 换算 Unicode 码点下标，保留正文的 UTF-16 坐标供切片。
	const offsets = [0];
	let offset = 0;
	for (const char of caption) {
		offset += char.length;
		offsets.push(offset);
	}
	const topics: { start: number; end: number; name: string }[] = [];
	for (const field of fields) {
		const extra = object(field);
		const name = text(extra.hashtag_name);
		const start = count(extra.start);
		const end = count(extra.end);
		if (
			extra.type !== 1 ||
			!name ||
			name.length > 64 ||
			start === undefined ||
			end === undefined ||
			start >= end
		)
			continue;
		const token = `#${name}`;
		if (end <= caption.length && caption.slice(start, end) === token) {
			topics.push({ start, end, name });
		} else if (end < offsets.length && caption.slice(offsets[start], offsets[end]) === token) {
			topics.push({ start: offsets[start], end: offsets[end], name });
		}
	}
	if (!topics.length) return;
	const segments: ExtensionRichText = [];
	let cursor = 0;
	for (const { start, end, name } of topics.sort((a, b) => a.start - b.start || b.end - a.end)) {
		if (start < cursor) continue;
		if (start > cursor) segments.push({ kind: "text", text: caption.slice(cursor, start) });
		segments.push({ kind: "topic", text: caption.slice(start, end), name });
		cursor = end;
	}
	if (cursor < caption.length) segments.push({ kind: "text", text: caption.slice(cursor) });
	return segments;
}

function postStats(value: unknown): ExtensionPostReport["post"]["stats"] {
	const statistics = object(value);
	const likes = count(statistics.digg_count);
	const comments = count(statistics.comment_count);
	const shares = count(statistics.share_count);
	const saves = count(statistics.collect_count);
	if (likes === undefined && comments === undefined && shares === undefined && saves === undefined)
		return;
	return {
		...(likes !== undefined && { likes }),
		...(comments !== undefined && { comments }),
		...(shares !== undefined && { shares }),
		...(saves !== undefined && { saves }),
	};
}

export async function toPostReport(
	ctx: ExtensionContext,
	data: unknown,
	signal: AbortSignal,
): Promise<Result<{ report: ExtensionPostReport }>> {
	const row = object(data);
	const identity = stamp(row);
	if (!identity) return fail("unavailable", ctx.i18n.t("error.posts"));
	const { id, time } = identity;
	const author = object(row.author);
	const name = text(author.nickname);
	const avatar = await image(ctx, author.avatar_thumb, signal);
	const caption = text(row.desc) ?? "";
	const richText = captionTopics(caption, row.text_extra);
	const stats = postStats(row.statistics);
	const post: ExtensionPostReport["post"] = {
		text: caption,
		publishedAt: new Date(time * 1000).toISOString(),
		...(name && { creator: { name, ...(avatar && { avatar }) } }),
		...(richText && { richText }),
		...(stats && { stats }),
	};
	const photos = Array.isArray(row.images) && row.images.length > 0;
	if (photos && Array.isArray(row.images)) {
		const images = [];
		for (const field of row.images) {
			const ref = await image(ctx, field, signal);
			if (ref) images.push(ref);
		}
		if (images.length) post.images = images;
	} else {
		const video = object(row.video);
		const cover = await image(ctx, video.cover ?? video.origin_cover, signal);
		const duration = count(video.duration);
		post.video = {
			...(cover && { cover }),
			...(duration !== undefined && { durationSec: Math.round(duration / 1000) }),
		};
	}
	if (signal.aborted) return fail("indeterminate", ctx.i18n.t("error.stopped"));
	return ok({
		report: { postId: id, url: `https://www.douyin.com/${photos ? "note" : "video"}/${id}`, post },
	});
}

export interface PostBaseline {
	time: number;
	ids: Set<string>;
}
// Stop below the previous second, never at an equal timestamp. Pins do not establish
// that boundary: Douyin returns them above works regardless of publication time.
export async function readPosts(
	ctx: ExtensionContext,
	client: DouyinSourceClient,
	author: string,
	baseline: PostBaseline | undefined,
	signal: AbortSignal,
): Promise<Result<{ reports: ExtensionPostReport[]; baseline: PostBaseline }>> {
	const incomplete = () => fail("unavailable", ctx.i18n.t("error.posts"));
	const rows = new Map<string, { id: string; time: number; aweme: Record<string, unknown> }>();
	const visited = new Set<string>();
	let cursor = "0";
	let watermark = baseline?.time ?? 0;
	for (let page = 0; page < 20; page++) {
		if (visited.has(cursor)) return incomplete();
		visited.add(cursor);
		const response = await client.posts(author, cursor, signal);
		if (!response.ok) return response;
		if (signal.aborted) return fail("indeterminate", ctx.i18n.t("error.stopped"));
		const body = object(response.data);
		if (!Array.isArray(body.aweme_list) || (body.has_more !== 0 && body.has_more !== 1))
			return incomplete();
		const regularTimes: number[] = [];
		for (const item of body.aweme_list) {
			const aweme = object(item);
			const work = stamp(aweme);
			if (!work || object(aweme.author).sec_uid !== author) return incomplete();
			rows.set(work.id, { ...work, aweme });
			watermark = Math.max(watermark, work.time);
			if (aweme.is_top !== 1 && aweme.is_top !== true) regularTimes.push(work.time);
		}
		const boundary = baseline?.time ?? watermark;
		if (body.has_more === 0 || regularTimes.some((time) => time < boundary)) {
			const ordered = Array.from(rows.values()).sort(
				(a, b) => a.time - b.time || a.id.length - b.id.length || a.id.localeCompare(b.id),
			);
			const ids = new Set(watermark === baseline?.time ? baseline.ids : []);
			const reports: ExtensionPostReport[] = [];
			for (const work of ordered) {
				if (work.time === watermark) ids.add(work.id);
				if (
					!baseline ||
					work.time < baseline.time ||
					(work.time === baseline.time && baseline.ids.has(work.id))
				)
					continue;
				const parsed = await toPostReport(ctx, work.aweme, signal);
				if (!parsed.ok) return parsed;
				reports.push(parsed.report);
			}
			return ok({ reports, baseline: { time: watermark, ids } });
		}
		const next = body.max_cursor;
		if ((typeof next !== "string" || !/^\d+$/.test(next)) && count(next) === undefined)
			return incomplete();
		cursor = String(next);
	}
	return incomplete();
}
