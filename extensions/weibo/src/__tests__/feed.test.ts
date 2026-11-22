import type { ExtensionSourceContext, SourceDef } from "@bilibili-notify/extension";
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
