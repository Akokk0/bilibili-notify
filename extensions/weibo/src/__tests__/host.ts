import { readFileSync } from "node:fs";
import {
	type ExtensionContext,
	type FetchOptions,
	fail,
	ok,
	type SourceAuth,
	type SourceDef,
} from "@bilibili-notify/extension";
import { CookieJar } from "tough-cookie";
import { type Mock, vi } from "vite-plus/test";
import { activate } from "../index";

const messages: Record<string, unknown> = JSON.parse(
	readFileSync(new URL("../../locales/zh-CN.json", import.meta.url), "utf8"),
);

export const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
export type Reply = { body?: unknown; status?: number; headers?: HeadersInit };
export type Handler = (url: URL, options: FetchOptions) => Reply | Promise<Reply>;

export function home(uid = "12345", name = "阿青", avatar?: string) {
	return `<script>window.$CONFIG=${JSON.stringify({ user: { idstr: uid, screen_name: name, avatar_large: avatar } })};</script>`;
}

export function qrReply(url: URL): Reply {
	switch (url.pathname) {
		case "/sso/signin":
			return {};
		case "/sso/v2/qrcode/image":
			return {
				body: { retcode: 20000000, data: { qrid: "fixture", image: "//v2.qr.weibo.cn/image" } },
			};
		case "/image":
			return { body: png, headers: { "content-type": "image/png" } };
		default:
			throw new Error(`Unexpected request to ${url.pathname}`);
	}
}

export function loginReply(url: URL): Reply {
	switch (url.pathname) {
		case "/sso/v2/qrcode/check":
			return {
				body: {
					retcode: 20000000,
					data: { url: "https://passport.weibo.com/sso/v2/login?alt=fixture" },
				},
			};
		case "/sso/v2/login":
			return { status: 302, headers: { location: "https://login.sina.com.cn/sso/v2/crossdomain" } };
		case "/sso/v2/crossdomain":
			return {
				status: 302,
				headers: {
					"set-cookie": "ALC=long; Secure; Path=/",
					location: "https://passport.weibo.com/sso/crossdomain",
				},
			};
		case "/sso/crossdomain":
			return {
				status: 302,
				headers: {
					"set-cookie": "SUB=active; Domain=weibo.com; Secure; Path=/",
					location: "https://weibo.com/",
				},
			};
		case "/":
			return { body: home() };
		default:
			return qrReply(url);
	}
}

interface TestHost {
	source: SourceDef;
	auth: SourceAuth;
	ctx: Pick<ExtensionContext, "reportProblem" | "resolveProblem">;
	fetch: Mock<ExtensionContext["http"]["fetch"]>;
	secrets: Map<string, string>;
	state: Map<string, number>;
	dispose(): void;
}
export function host(
	handle: Handler,
	secrets = new Map<string, string>(),
	fetchImage: ExtensionContext["fetchImage"] = async () => fail("not_found", "image"),
	state = new Map<string, number>(),
): TestHost {
	const life = new AbortController();
	const disposals: (() => void)[] = [];
	let source!: SourceDef;
	const fetch = vi.fn(async (input: URL | string, options: FetchOptions = {}) => {
		const url = new URL(input);
		const { body = "", status = 200, headers } = await handle(url, options);
		const raw = typeof body === "string" ? body : JSON.stringify(body);
		return ok({
			url: url.href,
			status,
			isSuccess: status >= 200 && status < 300,
			headers: new Headers(headers),
			body: body instanceof Uint8Array ? body : new TextEncoder().encode(raw),
			text: () => raw,
			json: () => {
				try {
					return ok({ value: JSON.parse(raw) });
				} catch {
					return fail("invalid", "JSON");
				}
			},
		});
	});
	const ctx = {
		signal: life.signal,
		http: { fetch },
		state: {
			get: (key: string) => state.get(key),
			set: async (key: string, value: number) => {
				state.set(key, value);
				return ok();
			},
		},
		fetchImage,
		secrets: {
			get: (key: string) => secrets.get(key),
			set: async (key: string, value: string) => {
				secrets.set(key, value);
				return ok();
			},
			delete: async (key: string) => {
				secrets.delete(key);
				return ok();
			},
		},
		createCookieSession(saved?: string) {
			const jar = saved ? CookieJar.deserializeSync(saved) : new CookieJar();
			return {
				header: (url: string) => jar.getCookieStringSync(url),
				ingest: (url: string, line: string) => {
					jar.setCookieSync(line, url, { ignoreError: true });
				},
				snapshot: () => JSON.stringify(jar.serializeSync()),
			};
		},
		i18n: {
			t(key: string, values?: Record<string, string | number>) {
				const message = messages[key];
				return values && typeof message === "string"
					? message.replace(/\{(\w+)\}/g, (_, field) => String(values[field]))
					: key;
			},
		},
		onDispose: (fn: () => void) => disposals.push(fn),
		redact: vi.fn(),
		reportProblem: vi.fn(),
		resolveProblem: vi.fn(),
		logger: { warn: vi.fn() },
		setTimeout(fn: () => void, ms: number) {
			const timer = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(timer) };
		},
		setInterval(fn: () => void, ms: number) {
			const timer = setInterval(fn, ms);
			return { dispose: () => clearInterval(timer) };
		},
		registerSource: (s: SourceDef) => {
			source = s;
			return { dispose() {} };
		},
	};
	activate(ctx as unknown as ExtensionContext);
	if (!source.auth) throw new Error("Weibo did not register a system account");
	return {
		source,
		auth: source.auth,
		ctx,
		fetch,
		secrets,
		state,
		dispose() {
			life.abort();
			for (const fn of disposals.reverse()) fn();
		},
	};
}
