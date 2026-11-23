import type {
	ExtensionContext,
	ExtensionPostReport,
	ExtensionSourceContext,
	SourceDef,
} from "@bilibili-notify/extension";
import { ok } from "@bilibili-notify/extension";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { host, loginReply } from "./host";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

function post(id: string, seconds: number, uid = "42") {
	return {
		idstr: id,
		mblogid: `M${id}`,
		user: { idstr: uid, screen_name: "海棠" },
		created_at: new Date(1700000000000 + seconds * 1000).toUTCString(),
		text_raw: `微博 ${id}`,
	};
}
function subscribe(source: SourceDef, ids = ["42", "43"]) {
	let current = ids;
	let changed = () => {};
	const ctx = {
		signal: new AbortController().signal,
		subscriptions: () =>
			current.map((externalId) => ({
				externalId,
				features: new Set(["post"]),
				monitorsLive: false,
			})),
		onSubscriptionsChanged(fn: () => void) {
			changed = fn;
			return { dispose() {} };
		},
		onDispose: vi.fn(),
		reportPost: vi.fn(),
		reportProblem: vi.fn(),
		resolveProblem: vi.fn(),
	};
	void source.start(ctx as unknown as ExtensionSourceContext);
	return {
		...ctx,
		update(ids: string[]) {
			current = ids;
			changed();
		},
	};
}

async function receivePost(
	fields: Record<string, unknown>,
	fetchImage?: ExtensionContext["fetchImage"],
	longText?: Record<string, unknown>,
) {
	const baseline = post("100", 1);
	let statuses = [baseline];
	const app = host(
		(url) => {
			if (url.pathname === "/ajax/statuses/longtext" && longText)
				return { body: { ok: 1, data: longText } };
			return url.pathname === "/ajax/feed/friendstimeline"
				? { body: { statuses } }
				: loginReply(url);
		},
		undefined,
		fetchImage,
	);
	try {
		await app.auth.beginLogin();
		await vi.advanceTimersByTimeAsync(3000);
		const watched = subscribe(app.source);
		await vi.advanceTimersByTimeAsync(0);
		statuses = [{ ...post("101", 2), ...fields }, baseline];
		await vi.advanceTimersByTimeAsync(62000);
		expect(watched.reportPost).toHaveBeenCalledTimes(1);
		return (watched.reportPost.mock.calls[0][1] as ExtensionPostReport).post;
	} finally {
		await app.source.stop();
		app.dispose();
	}
}

it("renders adjacent community and ordinary topics with the visible names and the community icon", async () => {
	const page = "https://weibo.com/p/10080854838a6bbae2a14b0fb0c7905f6a070a";
	const icon = "https://h5.sinaimg.cn/upload/timeline_card_small_super_default.png";
	const ref = `${"a".repeat(64)}.png`;
	const got = await receivePost(
		{
			text_raw: "Test#英雄联盟[超话]##火锅# \u200b\u200b\u200b",
			text: `Test<a href="${page}"><img class="icon-link" title="#英雄联盟[超话]#" src="${icon}"/>英雄联盟超话</a><a href="//s.weibo.com/weibo?q=%23火锅%23">#火锅#</a>`,
		},
		async (url) => {
			expect(url).toBe(icon);
			return ok({ ref });
		},
	);
	expect(got.text).toBe("Test英雄联盟超话#火锅#");
	expect(got.richText).toEqual([
		{ kind: "text", text: "Test" },
		{ kind: "link", text: "英雄联盟超话", url: page, icon: ref },
		{ kind: "topic", text: "#火锅#", name: "火锅" },
	]);
});

it("preserves literal hashes and highlights raw topics in a repost even when its badge is unavailable", async () => {
	const pageId = "10080854838a6bbae2a14b0fb0c7905f6a070a";
	const got = await receivePost({
		text_raw: "C# 和 #火锅#",
		retweeted_status: {
			user: { screen_name: "小星" },
			text_raw: "#峡谷[超话]#",
			url_struct: [
				{
					short_url: "#峡谷[超话]#",
					url_title: "峡谷超话",
					page_id: pageId,
					url_type_pic: "https://example.org/badge.png",
				},
			],
		},
	});
	expect(got.richText).toEqual([
		{ kind: "text", text: "C# 和 " },
		{ kind: "topic", text: "#火锅#", name: "火锅" },
		{ kind: "text", text: "\n//@小星：" },
		{ kind: "link", text: "峡谷超话", url: `https://weibo.com/p/${pageId}` },
	]);
	expect(got.richText?.map((part) => part.text).join("")).toBe(got.text);
});

it("reads topics, newlines and escaped characters from an expanded raw-only long post", async () => {
	const page = "https://weibo.com/p/10080854838a6bbae2a14b0fb0c7905f6a070a";
	const got = await receivePost({ isLongText: true }, undefined, {
		longTextContent_raw: `长文 &amp; 换行<br><a href="${page}"><img title="#峡谷[超话]#">峡谷超话</a>#火锅#`,
	});
	expect(got.text).toBe("长文 & 换行\n峡谷超话#火锅#");
	expect(got.richText).toEqual([
		{ kind: "text", text: "长文 & 换行\n" },
		{ kind: "link", text: "峡谷超话", url: page },
		{ kind: "topic", text: "#火锅#", name: "火锅" },
	]);
});

it("retains a long post's visible caption when its expanded body contains no text", async () => {
	const got = await receivePost({ isLongText: true, text_raw: "预览#火锅#" }, undefined, {
		longTextContent: "<br>",
	});
	expect(got.text).toBe("预览#火锅#");
	expect(got.richText).toContainEqual({ kind: "topic", text: "#火锅#", name: "火锅" });
});

it("does not report a post if its subscription was removed and recreated during image loading", async () => {
	let finishImage!: (result: ReturnType<typeof ok<{ ref: string }>>) => void;
	const picture = new Promise<ReturnType<typeof ok<{ ref: string }>>>((resolve) => {
		finishImage = resolve;
	});
	let updated = false;
	let imageSignal: AbortSignal | undefined;
	const app = host(
		(url) => {
			if (url.pathname !== "/ajax/feed/friendstimeline") return loginReply(url);
			const fresh = {
				...post("102", 2),
				pic_infos: { a: { large: { url: "https://wx1.sinaimg.cn/large/a.jpg" } } },
			};
			return { body: { statuses: updated ? [fresh, post("100", 1)] : [post("100", 1)] } };
		},
		undefined,
		async (_url, options) => {
			imageSignal = options?.signal;
			return picture;
		},
	);
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	const watched = subscribe(app.source);
	await vi.advanceTimersByTimeAsync(0);
	updated = true;
	await vi.advanceTimersByTimeAsync(60000);
	watched.update(["43"]);
	watched.update(["42", "43"]);
	expect(imageSignal?.aborted).toBe(true);
	finishImage(ok({ ref: `${"a".repeat(64)}.jpg` }));
	await vi.advanceTimersByTimeAsync(120000);
	expect(watched.reportPost).not.toHaveBeenCalled();
	await app.source.stop();
	app.dispose();
});

it("leaves the baseline in place when a post has no timezone and processes the corrected page on recovery", async () => {
	let phase = 0;
	const app = host((url) => {
		if (url.pathname !== "/ajax/feed/friendstimeline") return loginReply(url);
		const next = post("101", 2);
		if (phase === 1) next.created_at = "2040-01-01 12:00:00";
		return { body: { statuses: phase ? [next, post("100", 1)] : [post("100", 1)] } };
	});
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	const watched = subscribe(app.source);
	await vi.advanceTimersByTimeAsync(0);
	phase = 1;
	await vi.advanceTimersByTimeAsync(60000);
	expect(watched.reportPost).not.toHaveBeenCalled();
	phase = 2;
	await vi.advanceTimersByTimeAsync(60000);
	expect(watched.reportPost.mock.calls.map(([, r]) => r.postId)).toEqual(["101"]);
	await app.source.stop();
	app.dispose();
});

it("expands only a subscribed new long post and sends plain text, available counts and a library image reference", async () => {
	let updated = false;
	let details = 0;
	const ref = `${"a".repeat(64)}.png`;
	const app = host(
		(url) => {
			if (url.pathname === "/ajax/statuses/longtext") {
				details++;
				expect(url.searchParams.get("id")).toBe("M102");
				return { body: { ok: 1, data: { longTextContent: "海棠<br>风 &amp; 雨" } } };
			}
			if (url.pathname !== "/ajax/feed/friendstimeline") return loginReply(url);
			const old = { ...post("100", 1), isLongText: true };
			const fresh = {
				...post("102", 2),
				isLongText: true,
				attitudes_count: 0,
				comments_count: 7,
				pic_ids: ["img"],
				pic_infos: { img: { large: { url: "https://wx1.sinaimg.cn/large/photo.jpg" } } },
				retweeted_status: { user: { screen_name: "小星" }, text_raw: "原文" },
			};
			return {
				body: {
					statuses: updated
						? [old, { ...fresh, user: { idstr: "555" }, idstr: "105" }, fresh]
						: [old],
				},
			};
		},
		undefined,
		async (url, options) => {
			expect(url).toBe("https://wx1.sinaimg.cn/large/photo.jpg");
			expect(options?.headers).toEqual({ Referer: "https://weibo.com/" });
			return ok({ ref });
		},
	);
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	const watched = subscribe(app.source);
	await vi.advanceTimersByTimeAsync(0);
	updated = true;
	await vi.advanceTimersByTimeAsync(62000);
	expect(details).toBe(1);
	expect(watched.reportPost).toHaveBeenCalledWith(
		"42",
		expect.objectContaining({
			post: expect.objectContaining({
				text: "海棠\n风 & 雨\n//@小星：原文",
				images: [ref],
				stats: { likes: 0, comments: 7 },
			}),
		}),
	);
	await app.source.stop();
	app.dispose();
});

it("resumes the exact numeric cursor after a rate limit and reports the waiting posts once", async () => {
	const cursor = "9876543210987654321";
	const postId = "9223372036854775807";
	const calls: string[] = [];
	let limited = false;
	const app = host((url) => {
		if (url.pathname !== "/ajax/feed/friendstimeline") return loginReply(url);
		const since = url.searchParams.get("since_id") ?? "";
		calls.push(since);
		if (since === "0") {
			if (calls.length === 1) return { body: { statuses: [post("100", 1)] } };
			const createdAt = post(postId, 3).created_at;
			const row = `{"id":${postId},"user":{"id":42},"created_at":"${createdAt}"}`;
			return { body: `{"statuses":[${row}],"since_id":${cursor}}` };
		}
		if (!limited) {
			limited = true;
			return { status: 429, headers: { "retry-after": "120" } };
		}
		return { body: { statuses: [post("102", 2), post("100", 1)] } };
	});
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	const watched = subscribe(app.source);
	await vi.advanceTimersByTimeAsync(181000);
	expect(calls).toEqual(["0", "0", cursor]);
	expect(watched.reportPost).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(120000);
	expect(calls.slice(3)).toEqual([cursor, "0", cursor]);
	expect(watched.reportPost.mock.calls.map(([, r]) => r.postId)).toEqual(["102", postId]);
	await app.source.stop();
	app.dispose();
});

it("retries an interrupted second page without advancing the baseline or replaying already reported posts", async () => {
	let phase = 0;
	const cursor = "9876543210987654321";
	const app = host((url) => {
		if (url.pathname !== "/ajax/feed/friendstimeline") return loginReply(url);
		if (!phase) return { body: { statuses: [post("100", 1)] } };
		if (url.searchParams.get("since_id") === "0")
			return { body: { statuses: [post("103", 3)], since_id_str: cursor } };
		expect(url.searchParams.get("since_id")).toBe(cursor);
		if (phase === 1) return { status: 503 };
		return { body: { statuses: [post("102", 2), post("100", 1)], since_id_str: "0" } };
	});
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	const watched = subscribe(app.source);
	await vi.advanceTimersByTimeAsync(0);
	phase = 1;
	await vi.advanceTimersByTimeAsync(62000);
	expect(watched.reportPost).not.toHaveBeenCalled();
	phase = 2;
	await vi.advanceTimersByTimeAsync(120000);
	expect(watched.reportPost.mock.calls.map(([, r]) => r.postId)).toEqual(["102", "103"]);
	await app.source.stop();
	app.dispose();
});

it("reads one following feed for all subscriptions, establishes a silent baseline and reports new posts once in time order", async () => {
	let statuses = [post("100", 1)];
	let polls = 0;
	const app = host((url) => {
		if (url.pathname !== "/ajax/feed/friendstimeline") return loginReply(url);
		polls++;
		expect(url.searchParams.get("list_id")).toBe("1100012345");
		expect(url.searchParams.get("fid")).toBe("1100012345");
		return { body: { ok: 1, statuses, since_id: 0 } };
	});
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	const watched = subscribe(app.source);
	await vi.advanceTimersByTimeAsync(0);
	expect(polls).toBe(1);
	expect(watched.reportPost).not.toHaveBeenCalled();
	statuses = [post("103", 3, "43"), post("102", 2, "555"), post("101", 1), post("100", 1)];
	await vi.advanceTimersByTimeAsync(120000);
	expect(
		watched.reportPost.mock.calls.map(([uid, report]) => [
			uid,
			report.postId,
			report.post.text,
			report.url,
		]),
	).toEqual([
		["42", "101", "微博 101", "https://weibo.com/42/M101"],
		["43", "103", "微博 103", "https://weibo.com/43/M103"],
	]);
	expect(polls).toBe(3);
	await app.source.stop();
	await vi.advanceTimersByTimeAsync(60000);
	expect(polls).toBe(3);
	app.dispose();
});
