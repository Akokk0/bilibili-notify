import {
	type ExtensionContext,
	type ExtensionSourceContext,
	type FetchOptions,
	ok,
	type SourceDef,
} from "@bilibili-notify/extension";
import { expect, it, vi } from "vite-plus/test";
import { activate } from "../index";
import { testCookieSession } from "./support/cookie-session";

it("registers Douyin and reads a creator, explicit live status and new works through the host HTTP interface", async () => {
	const signal = new AbortController().signal;
	const author = {
		sec_uid: "MS4wLjABAAAA123",
		unique_id: "account_12",
		nickname: "阿青",
		live_status: 0,
	};
	let works: unknown[] = [];
	let source!: SourceDef;
	let tick!: () => Promise<void>;
	const paths: string[] = [];
	const fetch = vi.fn(async (input: URL | string, options: FetchOptions) => {
		const url = new URL(input);
		paths.push(url.pathname);
		expect(options.bare).toBe(true);
		expect(options.maxRedirects).toBe(0);
		let body: object;
		switch (url.pathname) {
			case "/web/api/v2/user/info/":
				expect(url.searchParams.get("unique_id")).toBe("account_12");
				body = { status_code: 0, user_info: author };
				break;
			case "/aweme/v1/web/user/profile/other/":
				expect(url.searchParams.get("sec_user_id")).toBe(author.sec_uid);
				expect(url.searchParams.has("a_bogus")).toBe(true);
				body = { status_code: 0, user: author };
				break;
			case "/aweme/v1/web/aweme/post/":
				expect(url.searchParams.get("sec_user_id")).toBe(author.sec_uid);
				body = { status_code: 0, aweme_list: works, has_more: 0 };
				break;
			default:
				throw new Error(`Unexpected URL ${url.pathname}`);
		}
		return ok({
			status: 200,
			isSuccess: true,
			headers: new Headers(),
			text: () => JSON.stringify(body),
			json: () => ok({ value: body }),
		});
	});
	activate({
		createCookieSession: testCookieSession,
		signal,
		i18n: { t: (k: string) => k },
		onDispose: vi.fn(),
		logger: { warn: vi.fn() },
		secrets: { get: () => undefined },
		setInterval(fn: () => Promise<void>) {
			tick = fn;
			return { dispose() {} };
		},
		registerSource(value: SourceDef) {
			source = value;
		},
		http: { fetch },
	} as unknown as ExtensionContext);
	expect(await source.searchCreators("account_12", signal)).toEqual({
		ok: true,
		candidates: [{ externalId: author.sec_uid, name: "阿青" }],
	});
	const host = {
		signal,
		subscriptions: () => [
			{ externalId: author.sec_uid, features: new Set(["post", "liveEnd"]), monitorsLive: true },
		],
		onSubscriptionsChanged: () => ({ dispose() {} }),
		onDispose: vi.fn(),
		reportProfile: vi.fn(),
		reportLive: vi.fn(),
		reportPost: vi.fn(),
		reportProblem: vi.fn(),
		resolveProblem: vi.fn(),
	};
	await source.start(host as unknown as ExtensionSourceContext);
	await tick();
	expect(host.reportProfile).toHaveBeenCalledWith(author.sec_uid, { name: "阿青" });
	expect(host.reportLive).toHaveBeenCalledWith(author.sec_uid, {
		kind: "status",
		isLive: false,
		details: {},
	});
	works = [
		{
			aweme_id: "7520000000000000032",
			create_time: 1700000000,
			desc: "新作品",
			author,
			video: { duration: 1200 },
		},
	];
	await tick();
	expect(host.reportPost).toHaveBeenCalledWith(
		author.sec_uid,
		expect.objectContaining({
			postId: "7520000000000000032",
			url: "https://www.douyin.com/video/7520000000000000032",
		}),
	);
	await source.stop();
	expect(paths).toHaveLength(6);
});
