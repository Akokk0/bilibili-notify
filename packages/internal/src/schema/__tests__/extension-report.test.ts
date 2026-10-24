import { describe, expect, it } from "vite-plus/test";
import {
	checkExtensionReport,
	ExtensionCreatorCandidatesSchema,
	ExtensionLiveStatusResultSchema,
	ExtensionSourceHealthSchema,
} from "../extension-report";
import {
	SUBSCRIPTION_REPORT_TEXT_MAX,
	SUBSCRIPTION_REPORT_TITLE_MAX,
} from "../subscription-report";

const T = Date.UTC(2026, 8, 23, 12, 0, 0);
const IMAGE = `${"a".repeat(64)}.png`;
const URL = "https://example.com/post/1";
const POST = {
	postId: "post-1",
	url: URL,
	post: {
		publishedAt: T,
		text: "body",
	},
};

function rejected(kind: Parameters<typeof checkExtensionReport>[0], raw: unknown) {
	const result = checkExtensionReport(kind, raw);
	if (result.ok) throw new Error(`expected rejection, got ${JSON.stringify(result.value)}`);
	return result.issues;
}

function dropped(kind: Parameters<typeof checkExtensionReport>[0], raw: unknown) {
	const result = checkExtensionReport(kind, raw);
	if (!result.ok) throw new Error(`expected drops, got ${JSON.stringify(result.issues)}`);
	return result.dropped;
}

describe("post report", () => {
	it("accepts the required envelope and body without changes", () => {
		expect(checkExtensionReport("post", POST)).toEqual({
			ok: true,
			value: POST,
			dropped: [],
		});
	});

	it("normalizes the single topic like the v2 topic names", () => {
		expect(
			checkExtensionReport("post", {
				...POST,
				post: { ...POST.post, topic: " #topic# " },
			}),
		).toEqual({
			ok: true,
			value: { ...POST, post: { ...POST.post, topic: "topic" } },
			dropped: [],
		});
	});

	it("accepts every open post field with image refs and milliseconds", () => {
		const full = {
			...POST,
			post: {
				creator: { name: "creator", avatar: IMAGE },
				publishedAt: T,
				topic: "topic",
				text: "body",
				images: [IMAGE],
				video: {
					cover: IMAGE,
					title: "video",
					description: "details",
					durationSec: 61.5,
					views: 12,
				},
				stats: { likes: 3, comments: 2, shares: 1 },
			},
		};
		expect(checkExtensionReport("post", full)).toEqual({
			ok: true,
			value: full,
			dropped: [],
		});
	});

	it("rejects the whole report when any object level has an unknown field", () => {
		expect(rejected("post", { ...POST, unexpected: true })).toContainEqual(
			expect.objectContaining({ path: ["unexpected"], code: "unknown-field" }),
		);
		expect(rejected("post", { ...POST, post: { ...POST.post, title: "not open" } })).toContainEqual(
			expect.objectContaining({ path: ["post", "title"], code: "unknown-field" }),
		);
		expect(
			rejected("post", { ...POST, post: { ...POST.post, video: { repost: true } } }),
		).toContainEqual(
			expect.objectContaining({ path: ["post", "video", "repost"], code: "unknown-field" }),
		);
	});

	it("rejects missing or invalid required fields with a structured path", () => {
		const { text: _text, ...withoutText } = POST.post;
		expect(rejected("post", { ...POST, post: withoutText })).toContainEqual(
			expect.objectContaining({ path: ["post", "text"], code: "required" }),
		);
		expect(rejected("post", { ...POST, post: { ...POST.post, text: 42 } })).toContainEqual(
			expect.objectContaining({ path: ["post", "text"], code: "type" }),
		);
		expect(
			rejected("post", { ...POST, post: { ...POST.post, publishedAt: Math.floor(T / 1000) } }),
		).toContainEqual(
			expect.objectContaining({
				path: ["post", "publishedAt"],
				code: "below-min",
				limit: Date.UTC(2000, 0, 1),
			}),
		);
	});

	it("drops an invalid optional cell without losing its valid siblings", () => {
		const result = checkExtensionReport("post", {
			...POST,
			post: {
				...POST.post,
				stats: { likes: -1, comments: 2 },
			},
		});
		if (!result.ok) throw new Error(JSON.stringify(result.issues));
		expect(result.value.post.stats).toEqual({ comments: 2 });
		expect(result.dropped).toContainEqual(
			expect.objectContaining({
				path: ["post", "stats", "likes"],
				code: "negative",
			}),
		);
	});

	it("truncates body and video title but only drops other overlong optional text", () => {
		const result = checkExtensionReport("post", {
			...POST,
			post: {
				...POST.post,
				text: "x".repeat(SUBSCRIPTION_REPORT_TEXT_MAX + 1),
				video: {
					title: "y".repeat(SUBSCRIPTION_REPORT_TITLE_MAX + 1),
					description: "z".repeat(SUBSCRIPTION_REPORT_TEXT_MAX + 1),
				},
			},
		});
		if (!result.ok) throw new Error(JSON.stringify(result.issues));
		expect(result.value.post.text).toHaveLength(SUBSCRIPTION_REPORT_TEXT_MAX);
		expect(result.value.post.video).toEqual({
			title: "y".repeat(SUBSCRIPTION_REPORT_TITLE_MAX),
		});
		expect(result.dropped).toEqual([
			{ path: ["post", "text"], code: "too-long", limit: SUBSCRIPTION_REPORT_TEXT_MAX },
			{ path: ["post", "video", "title"], code: "too-long", limit: SUBSCRIPTION_REPORT_TITLE_MAX },
			{
				path: ["post", "video", "description"],
				code: "too-long",
				limit: SUBSCRIPTION_REPORT_TEXT_MAX,
			},
		]);
	});

	it("does not split a surrogate pair at the truncation boundary", () => {
		const result = checkExtensionReport("post", {
			...POST,
			post: {
				...POST.post,
				text: `${"x".repeat(SUBSCRIPTION_REPORT_TEXT_MAX - 1)}😀tail`,
			},
		});
		if (!result.ok) throw new Error(JSON.stringify(result.issues));
		expect(result.value.post.text).toBe("x".repeat(SUBSCRIPTION_REPORT_TEXT_MAX - 1));
	});

	it("checks the post external id length", () => {
		expect(rejected("post", { ...POST, postId: "" })).toContainEqual(
			expect.objectContaining({ path: ["postId"], code: "too-short", limit: 1 }),
		);
		expect(rejected("post", { ...POST, postId: "x".repeat(257) })).toContainEqual(
			expect.objectContaining({ path: ["postId"], code: "too-long", limit: 256 }),
		);
		expect(checkExtensionReport("post", { ...POST, postId: "x".repeat(256) })).toEqual({
			ok: true,
			value: { ...POST, postId: "x".repeat(256) },
			dropped: [],
		});
	});

	it("accepts all five rich text segment kinds", () => {
		const richText = [
			{ kind: "text", text: "plain" },
			{ kind: "mention", text: "@name", userId: "user-1" },
			{ kind: "topic", text: "#topic", name: "topic" },
			{ kind: "link", text: "link", url: "https://example.com", icon: IMAGE },
			{ kind: "emoji", text: "[doge]", image: IMAGE },
		];
		expect(
			checkExtensionReport("post", {
				...POST,
				post: { ...POST.post, richText },
			}),
		).toEqual({
			ok: true,
			value: { ...POST, post: { ...POST.post, richText } },
			dropped: [],
		});
	});

	it("drops an invalid rich text segment and points at that segment", () => {
		expect(
			dropped("post", {
				...POST,
				post: {
					...POST.post,
					richText: [
						{ kind: "text", text: "plain" },
						{ kind: "mention", text: "@name", userId: 42 },
					],
				},
			}),
		).toContainEqual(
			expect.objectContaining({ path: ["post", "richText", 1, "userId"], code: "type" }),
		);
	});

	it("accepts image refs by shape and drops malformed refs", () => {
		const result = checkExtensionReport("post", {
			...POST,
			post: {
				...POST.post,
				images: [IMAGE, "not-an-image-ref"],
				creator: { avatar: "also-bad" },
			},
		});
		if (!result.ok) throw new Error(JSON.stringify(result.issues));
		expect(result.value.post.images).toEqual([IMAGE]);
		expect(result.value.post.creator).toEqual({});
		expect(result.dropped).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: ["post", "images", 1], code: "invalid" }),
				expect.objectContaining({ path: ["post", "creator", "avatar"], code: "invalid" }),
			]),
		);
	});
});

describe("live reports", () => {
	it("accepts start, status, and end with millisecond timestamps", () => {
		const details = {
			creator: { name: "creator", avatar: IMAGE },
			title: "live",
			cover: IMAGE,
			category: "chat",
			url: "https://example.com/live/1",
			currentViewers: 12,
			totalViewers: 34,
			likes: 5,
			description: "details",
		};
		const reports = [
			{ kind: "start" as const, startedAt: T, details },
			{ kind: "status" as const, isLive: true, startedAt: T, details },
			{ kind: "end" as const, endedAt: T, startedAt: T, details },
		];
		for (const report of reports) {
			expect(checkExtensionReport("live", report)).toEqual({
				ok: true,
				value: report,
				dropped: [],
			});
		}
	});

	it("allows end without endedAt and allows omitted details", () => {
		expect(checkExtensionReport("live", { kind: "end" })).toEqual({
			ok: true,
			value: { kind: "end" },
			dropped: [],
		});
	});

	it("rejects a bad discriminator or required status field", () => {
		expect(rejected("live", { kind: "other" })).toContainEqual(
			expect.objectContaining({ path: ["kind"], code: "invalid" }),
		);
		expect(rejected("live", { kind: "status", details: {} })).toContainEqual(
			expect.objectContaining({ path: ["isLive"], code: "required" }),
		);
	});

	it("drops bad optional live details and counts", () => {
		expect(
			dropped("live", {
				kind: "start",
				startedAt: T,
				details: { currentViewers: -1, totalViewers: 5, cover: "bad" },
			}),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: ["details", "currentViewers"],
					code: "negative",
				}),
				expect.objectContaining({ path: ["details", "cover"], code: "invalid" }),
			]),
		);
	});
});

describe("profile report", () => {
	it("accepts profile fields from the core shape", () => {
		const report = {
			name: "creator",
			avatar: IMAGE,
			bio: "bio",
			followers: 10,
			fanClubName: "club",
		};
		expect(checkExtensionReport("profile", report)).toEqual({
			ok: true,
			value: report,
			dropped: [],
		});
	});

	it("rejects a missing name and drops bad optional fields", () => {
		expect(rejected("profile", {})).toContainEqual(
			expect.objectContaining({ path: ["name"], code: "required" }),
		);
		expect(
			dropped("profile", {
				name: "creator",
				avatar: "bad",
				followers: -1,
			}),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: ["avatar"], code: "invalid" }),
				expect.objectContaining({ path: ["followers"], code: "negative" }),
			]),
		);
	});
});

describe("creator candidates", () => {
	it("accepts up to ten candidates with unique external ids", () => {
		const candidates = Array.from({ length: 10 }, (_, i) => ({
			externalId: `creator-${i}`,
			name: `Creator ${i}`,
			avatar: IMAGE,
			bio: "bio",
			followers: i,
			fanClubName: "club",
		}));
		expect(ExtensionCreatorCandidatesSchema.safeParse(candidates).success).toBe(true);
	});

	it("rejects eleven candidates and duplicate external ids", () => {
		const candidates = Array.from({ length: 10 }, (_, i) => ({
			externalId: `creator-${i}`,
			name: `Creator ${i}`,
		}));
		expect(
			ExtensionCreatorCandidatesSchema.safeParse([
				...candidates,
				{ externalId: "creator-10", name: "Creator 10" },
			]).success,
		).toBe(false);
		expect(
			ExtensionCreatorCandidatesSchema.safeParse([
				candidates[0],
				{ ...candidates[1], externalId: candidates[0].externalId },
			]).success,
		).toBe(false);
	});

	it.each([
		["empty name", { externalId: "creator-1", name: "" }, ["0", "name"]],
		["long name", { externalId: "creator-1", name: "n".repeat(129) }, ["0", "name"]],
		["empty external id", { externalId: "", name: "Creator 1" }, ["0", "externalId"]],
		["long external id", { externalId: "x".repeat(257), name: "Creator 1" }, ["0", "externalId"]],
		[
			"negative followers",
			{ externalId: "creator-1", name: "Creator 1", followers: -1 },
			["0", "followers"],
		],
		[
			"fractional followers",
			{ externalId: "creator-1", name: "Creator 1", followers: 1.5 },
			["0", "followers"],
		],
		["unknown field", { externalId: "creator-1", name: "Creator 1", url: URL }, ["0"]],
	])("rejects %s", (_label, candidate, path) => {
		const result = ExtensionCreatorCandidatesSchema.safeParse([candidate]);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues.some((issue) => issue.path.join(".") === path.join("."))).toBe(true);
	});
});

describe("live status result", () => {
	it("accepts live, offline, and failure branches", () => {
		for (const report of [
			{
				ok: true,
				kind: "live",
				startedAt: T,
				details: { currentViewers: 10, creator: { name: "creator", avatar: IMAGE } },
			},
			{ ok: true, kind: "offline" },
			{ ok: false, code: "unavailable", message: "upstream unavailable" },
		]) {
			expect(ExtensionLiveStatusResultSchema.safeParse(report).success).toBe(true);
		}
	});

	it("rejects malformed branches and a non-millisecond timestamp", () => {
		expect(
			ExtensionLiveStatusResultSchema.safeParse({ ok: true, kind: "offline", details: {} }).success,
		).toBe(false);
		expect(
			ExtensionLiveStatusResultSchema.safeParse({
				ok: true,
				kind: "live",
				startedAt: Math.floor(T / 1000),
				details: {},
			}).success,
		).toBe(false);
		expect(
			ExtensionLiveStatusResultSchema.safeParse({ ok: false, code: "made-up", message: "no" })
				.success,
		).toBe(false);
	});
});

describe("source health", () => {
	it("accepts exactly one summary string", () => {
		expect(ExtensionSourceHealthSchema.safeParse({ summary: "healthy" }).success).toBe(true);
		expect(ExtensionSourceHealthSchema.safeParse({ summary: 1 }).success).toBe(false);
		expect(ExtensionSourceHealthSchema.safeParse({ summary: "healthy", extra: true }).success).toBe(
			false,
		);
	});
});

describe("hostile input", () => {
	it("rejects non-objects and getters that throw without leaking an exception", () => {
		expect(rejected("post", null)).toContainEqual(
			expect.objectContaining({ path: [], code: "type" }),
		);
		const hostile = {
			...POST,
			get postId(): string {
				throw new Error("boom");
			},
		};
		expect(rejected("post", hostile)).toContainEqual(
			expect.objectContaining({ path: [], code: "invalid" }),
		);
	});
});
