import type { ExtensionContext, FetchOptions, SourceDef } from "@bilibili-notify/extension";
import { fail, ok } from "@bilibili-notify/extension";
import { type Mock, vi } from "vite-plus/test";
import { activate } from "../index";

export type Reply = { status?: number; headers?: HeadersInit; body?: unknown };
interface TestHost {
	source: SourceDef;
	ctx: {
		fetchImage: Mock<ExtensionContext["fetchImage"]>;
		reportProblem: Mock;
		resolveProblem: Mock;
	};
	fetch: Mock<ExtensionContext["http"]["fetch"]>;
	state: Map<string, unknown>;
	signal: AbortSignal;
	dispose(): void;
}
export function host(
	handle: (url: URL, options: FetchOptions) => Reply | Promise<Reply>,
	state = new Map<string, unknown>(),
): TestHost {
	let source!: SourceDef;
	const life = new AbortController();
	const fetch = vi.fn(async (input: URL | string, options: FetchOptions = {}) => {
		const { body, status = 200, headers } = await handle(new URL(input), options);
		const raw = typeof body === "string" ? body : JSON.stringify(body ?? "");
		return ok({
			url: String(input),
			status,
			isSuccess: status >= 200 && status < 300,
			headers: new Headers(headers),
			text: () => raw,
			body: new TextEncoder().encode(raw),
			json() {
				try {
					return ok({ value: JSON.parse(raw) });
				} catch {
					return fail("invalid", "JSON");
				}
			},
		});
	});
	const reportProblem = vi.fn();
	const resolveProblem = vi.fn();
	const ctx = {
		signal: life.signal,
		http: { fetch },
		reportProblem,
		resolveProblem,
		i18n: { t: (key: string) => key },
		state: {
			get: (key: string) => state.get(key),
			set: async (key: string, value: unknown) => {
				state.set(key, value);
				return ok();
			},
			delete: async (key: string) => {
				state.delete(key);
				return ok();
			},
		},
		registerSource: (def: SourceDef) => {
			source = def;
		},
		setTimeout(fn: () => void, delay: number) {
			const id = setTimeout(fn, delay);
			return { dispose: () => clearTimeout(id) };
		},
		fetchImage: vi.fn<ExtensionContext["fetchImage"]>(async () => fail("not_found", "no image")),
	};
	activate(ctx as unknown as ExtensionContext);
	return { source, ctx, fetch, state, signal: life.signal, dispose: () => life.abort() };
}

export function room(
	uid: string,
	number: string,
	status = "OFF",
	live: Record<string, unknown> = {},
) {
	return {
		status: 200,
		data: {
			profileInfo: { uid, profileRoom: number, nick: "阿虎" },
			liveStatus: status,
			realLiveStatus: status,
			liveData: live,
		},
	};
}
