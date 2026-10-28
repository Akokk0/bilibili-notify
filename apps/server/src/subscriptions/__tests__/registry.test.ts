import { ok, type Source, type SourceAuth } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { noCandidates, noProfile } from "../../__tests__/support/no-candidates.js";
import { createSourceRegistry, listLoginSources } from "../registry.js";
import { makeIntegration, makeLogger, makeSource, SOURCE_KEY } from "./fixtures.js";

// 登记表只认 `SourceContext` 的形状;这里的上下文只用到 logger,其余不碰。
const ctxOf = () => {
	const logger = makeLogger();
	// biome-ignore lint/suspicious/noExplicitAny: 登记表测试只需要 logger
	return { logger, ctx: { ...makeIntegration(logger) } as any };
};

describe("createSourceRegistry", () => {
	it("登记即 start,get 查得到视图,没登的是 undefined", async () => {
		const registry = createSourceRegistry();
		const source = makeSource();
		const { ctx } = ctxOf();
		await registry.register(SOURCE_KEY, source, ctx);
		expect(source.started).toEqual([ctx]);
		expect(registry.get(SOURCE_KEY)?.descriptor).toBe(source.descriptor);
		expect(registry.get("other")).toBeUndefined();
	});

	it("list 按登记先后列出全部在册来源;撤了的不列", async () => {
		const registry = createSourceRegistry();
		expect(registry.list()).toEqual([]);
		const first = makeSource();
		const second = makeSource();
		await registry.register("one", first, ctxOf().ctx);
		const secondHandle = await registry.register("two", second, ctxOf().ctx);
		expect(registry.list().map((view) => view.descriptor)).toEqual([
			first.descriptor,
			second.descriptor,
		]);
		secondHandle.dispose();
		expect(registry.list().map((view) => view.descriptor)).toEqual([first.descriptor]);
	});

	// 验红:`registry.ts` 的 register 不体检描述符的 externalIdRegex,坏正则的来源就登记进去了。
	it("描述符声明的 externalIdRegex 编译不过 / 过长 / 疑似灾难性回溯:拒收这个来源,不 start、不占键", async () => {
		const registry = createSourceRegistry();
		for (const externalIdRegex of ["(", "a".repeat(201), "(a+)+$"]) {
			const bad = makeSource();
			bad.descriptor.externalIdRegex = externalIdRegex;
			await expect(registry.register("bad", bad, ctxOf().ctx)).rejects.toThrow(
				`source "bad" 的 externalIdRegex 不合规`,
			);
			expect(bad.started).toEqual([]);
			expect(registry.get("bad")).toBeUndefined();
		}
		// 键没被占:好的来源接着能登。
		await registry.register("bad", makeSource(), ctxOf().ctx);
	});

	it("externalIdRegex 合规(或没声明)的来源照常登记", async () => {
		const registry = createSourceRegistry();
		const good = makeSource();
		good.descriptor.externalIdRegex = "^\\d+$";
		await registry.register("good", good, ctxOf().ctx);
		expect(registry.get("good")?.descriptor.externalIdRegex).toBe("^\\d+$");
	});

	it("视图里没有 start / stop", async () => {
		const registry = createSourceRegistry();
		await registry.register(SOURCE_KEY, makeSource(), ctxOf().ctx);
		const view = registry.get(SOURCE_KEY);
		expect(view).toBeDefined();
		expect(view && "start" in view).toBe(false);
		expect(view && "stop" in view).toBe(false);
	});

	// 验红:`registry.ts` 手抄视图时漏掉 `health`,这条红(类型检查不会红,症状是 status 里那一行静默消失)。
	it("视图带着来源的 health(调用时 this 仍是来源自己);没交的来源视图上也没有", async () => {
		const registry = createSourceRegistry();
		const withHealth: Source = {
			descriptor: { label: "甲", supportedFeatures: ["post"] },
			searchCreators: noCandidates,
			fetchProfile: noProfile,
			start: async () => {},
			stop: async () => {},
			health() {
				return { summary: this === withHealth ? "我" : "this 丢了" };
			},
		};
		await registry.register("with", withHealth, ctxOf().ctx);
		await registry.register("without", makeSource(), ctxOf().ctx);
		expect(registry.get("with")?.health?.()).toEqual({ summary: "我" });
		expect(registry.get("without")?.health).toBeUndefined();
		expect(registry.list().map((view) => view.health?.().summary)).toEqual(["我", undefined]);
	});

	// 验红:`registry.ts` 手抄视图时漏掉 `searchCreators`,这条红(搜人的宿主外壳就找不到它)。
	it("视图带着来源的 searchCreators(调用时 this 仍是来源自己)", async () => {
		const registry = createSourceRegistry();
		const searcher: Source = {
			descriptor: { label: "甲", supportedFeatures: ["post"] },
			fetchProfile: noProfile,
			start: async () => {},
			stop: async () => {},
			async searchCreators(query) {
				return {
					ok: true,
					candidates: [{ externalId: query, name: this === searcher ? "我" : "this 丢了" }],
				};
			},
		};
		await registry.register("s", searcher, ctxOf().ctx);
		const signal = new AbortController().signal;
		expect(await registry.get("s")?.searchCreators("q", signal)).toEqual({
			ok: true,
			candidates: [{ externalId: "q", name: "我" }],
		});
	});

	it("视图带着来源的 fetchProfile(调用时 this 仍是来源自己)", async () => {
		const registry = createSourceRegistry();
		const profiler: Source = {
			descriptor: { label: "甲", supportedFeatures: ["post"] },
			searchCreators: noCandidates,
			start: async () => {},
			stop: async () => {},
			async fetchProfile(identity) {
				return ok({ name: this === profiler ? identity.externalId : "this 丢了" });
			},
		};
		await registry.register("profile", profiler, ctxOf().ctx);
		const identity = { sourceKey: "profile", externalId: "alice" };
		expect(
			await registry.get("profile")?.fetchProfile(identity, new AbortController().signal),
		).toEqual(ok({ name: "alice" }));
	});

	// 验红:`registry.ts` 手抄视图时漏掉 `fetchPreview`,这条红(卡片预览就一律只有示例、`has.preview` 也是 false)。
	it("视图带着来源的 fetchPreview(调用时 this 仍是来源自己);没交的来源视图上也没有", async () => {
		const registry = createSourceRegistry();
		const previewer: Source = {
			descriptor: { label: "甲", supportedFeatures: ["post"] },
			searchCreators: noCandidates,
			fetchProfile: noProfile,
			start: async () => {},
			stop: async () => {},
			async fetchPreview(identity, options) {
				return ok({
					kind: "post" as const,
					report: {
						postId: options.kind === "post" ? String(options.nth) : "live",
						url: "https://example.com/p",
						post: {
							creator: { name: this === previewer ? identity.externalId : "this 丢了" },
							publishedAt: "2026-10-28T00:00:00.000Z",
							text: "正文",
						},
					},
				});
			},
		};
		await registry.register("preview", previewer, ctxOf().ctx);
		await registry.register("without", makeSource(), ctxOf().ctx);
		const got = await registry
			.get("preview")
			?.fetchPreview?.(
				{ sourceKey: "preview", externalId: "alice" },
				{ kind: "post", nth: 2 },
				new AbortController().signal,
			);
		expect(got).toMatchObject({
			ok: true,
			kind: "post",
			report: { postId: "2", post: { creator: { name: "alice" } } },
		});
		expect(registry.get("without")?.fetchPreview).toBeUndefined();
	});

	// 验红:`register` 里认领视图时漏掉 `sourceKey`,这条红(`login <键>` 就认不出来源)。
	it("视图带着登记时认领的键;listLoginSources 只挑带登录口的,键、名字、登录口原样、按登记先后", async () => {
		const registry = createSourceRegistry();
		const auth: SourceAuth = {
			beginLogin: async () => ok(),
			logout: async () => ok(),
			state: () => ({ status: "logged-out" }),
			onChange: () => ({ dispose() {} }),
		};
		const withAuth: Source = {
			descriptor: { label: "甲", supportedFeatures: ["post"] },
			searchCreators: noCandidates,
			fetchProfile: noProfile,
			start: async () => {},
			stop: async () => {},
			auth,
		};
		await registry.register("a.one", withAuth, ctxOf().ctx);
		await registry.register("b.two", makeSource(), ctxOf().ctx);
		expect(registry.get("a.one")?.sourceKey).toBe("a.one");
		expect(listLoginSources(registry.list())).toEqual([{ sourceKey: "a.one", label: "甲", auth }]);
	});

	it("键被占了就抛,原主人不动、新来源没被 start", async () => {
		const registry = createSourceRegistry();
		const first = makeSource();
		const second = makeSource();
		await registry.register(SOURCE_KEY, first, ctxOf().ctx);
		await expect(registry.register(SOURCE_KEY, second, ctxOf().ctx)).rejects.toThrow(
			`source for key "${SOURCE_KEY}" is already registered`,
		);
		expect(second.started).toHaveLength(0);
		expect(registry.get(SOURCE_KEY)?.descriptor).toBe(first.descriptor);
	});

	it("start 抛了:键放掉、错原样抛出去、能重登", async () => {
		const registry = createSourceRegistry();
		const broken: Source = {
			descriptor: { label: "测试", supportedFeatures: ["post"] },
			searchCreators: noCandidates,
			fetchProfile: noProfile,
			start: () => Promise.reject(new Error("start-boom")),
			stop: async () => {},
		};
		await expect(registry.register(SOURCE_KEY, broken, ctxOf().ctx)).rejects.toThrow("start-boom");
		expect(registry.get(SOURCE_KEY)).toBeUndefined();
		await registry.register(SOURCE_KEY, makeSource(), ctxOf().ctx);
		expect(registry.get(SOURCE_KEY)).toBeDefined();
	});

	it("把手 dispose:放键并调 stop;幂等", async () => {
		const registry = createSourceRegistry();
		const source = makeSource();
		const handle = await registry.register(SOURCE_KEY, source, ctxOf().ctx);
		handle.dispose();
		handle.dispose();
		expect(registry.get(SOURCE_KEY)).toBeUndefined();
		expect(source.stops).toBe(1);
	});

	it("撤旧把手不踢新主人", async () => {
		const registry = createSourceRegistry();
		const oldHandle = await registry.register(SOURCE_KEY, makeSource(), ctxOf().ctx);
		oldHandle.dispose();
		const next = makeSource();
		await registry.register(SOURCE_KEY, next, ctxOf().ctx);
		oldHandle.dispose();
		expect(registry.get(SOURCE_KEY)?.descriptor).toBe(next.descriptor);
		expect(next.stops).toBe(0);
	});

	// 验红:registry.ts 的把手 `dispose` 不等 stop(直接交回 `Promise.resolve()`),这条红。
	it("把手 dispose 同步放键、同步调 stop;交回的 promise 在 stop 落定之后才落定,再调交回同一个", async () => {
		const registry = createSourceRegistry();
		const source = makeSource();
		let finishStop = () => {};
		source.stop = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishStop = resolve;
				}),
		);
		const handle = await registry.register(SOURCE_KEY, source, ctxOf().ctx);
		const done = handle.dispose();
		expect(registry.get(SOURCE_KEY)).toBeUndefined();
		expect(source.stop).toHaveBeenCalledTimes(1);
		expect(handle.dispose()).toBe(done);
		expect(source.stop).toHaveBeenCalledTimes(1);
		let settled = false;
		void done.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(settled).toBe(false);
		finishStop();
		await done;
		expect(settled).toBe(true);
	});

	// 验红:去掉把手里的超时(只等 stopped),stop 一直不落定时这条一直等、超时失败。
	it("stop 一直不落定:到时限照样落定,并记一行 warn", async () => {
		const registry = createSourceRegistry({ disposeTimeoutMs: 20 });
		const source = makeSource();
		source.stop = vi.fn(() => new Promise<void>(() => {}));
		const { ctx, logger } = ctxOf();
		const handle = await registry.register(SOURCE_KEY, source, ctx);
		await handle.dispose();
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn.mock.calls[0]?.[0]).toContain(`[source] ${SOURCE_KEY} stop 超过 20ms`);
	});

	it("stop 失败只记一行 warn,不往外抛(同步抛与异步拒绝都一样)", async () => {
		const registry = createSourceRegistry();
		for (const stop of [
			() => {
				throw new Error("sync-boom");
			},
			() => Promise.reject(new Error("async-boom")),
		]) {
			const { ctx, logger } = ctxOf();
			const source: Source = {
				descriptor: { label: "测试", supportedFeatures: ["post"] },
				searchCreators: noCandidates,
				fetchProfile: noProfile,
				start: async () => {},
				stop,
			};
			const handle = await registry.register(SOURCE_KEY, source, ctx);
			expect(() => handle.dispose()).not.toThrow();
			await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(1));
			expect(logger.warn.mock.calls[0]?.[0]).toContain(`[source] ${SOURCE_KEY} stop 失败`);
		}
	});
});
