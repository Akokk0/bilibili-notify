/**
 * 覆盖 LiveEngine 的 setImageRenderer / setCommentary 后置注入接口。Adapter
 * (koishi 端 ctx.inject,独立端 globals-changed)在 image / ai 服务上下线时
 * 调这两个 setter;此处直接对子组件 (WordcloudGenerator / LiveSummaryRequester)
 * 与 LiveEngine 整体行为做白盒覆盖,防止后置注入链路被静默回退。
 */
import type { CommentaryGenerator } from "@bilibili-notify/ai";
import type { ImageRenderer } from "@bilibili-notify/image";
import type { Logger } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { WordcloudGenerator } from "../wordcloud-generator";

const fakeLogger = (): Logger =>
	({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		// biome-ignore lint/suspicious/noExplicitAny: Logger 实际接口在 internal,这里只做最小子集。
	}) as any;

const buildWords = (n: number): Array<[string, number]> =>
	Array.from({ length: n }, (_, i) => [`w${i}`, n - i]);

const fakeRenderer = (): ImageRenderer => {
	const generateWordCloudImg = vi.fn(async () => Buffer.from("wc"));
	return { generateWordCloudImg } as unknown as ImageRenderer;
};

describe("WordcloudGenerator — getImageRenderer provider 模式", () => {
	it("provider 返回 null → generate 返回 undefined,不调渲染器", async () => {
		const wc = new WordcloudGenerator({ getImageRenderer: () => null, logger: fakeLogger() });
		const buf = await wc.generate(buildWords(60), "Master");
		expect(buf).toBeUndefined();
	});

	it("provider 现取 → 中途替换实例,下次 generate 走新实例", async () => {
		let current: ImageRenderer | null = null;
		const wc = new WordcloudGenerator({
			getImageRenderer: () => current,
			logger: fakeLogger(),
		});
		// 第一次:没渲染器 → undefined
		expect(await wc.generate(buildWords(60), "M1")).toBeUndefined();

		// 中途注入
		const r = fakeRenderer();
		current = r;
		expect(await wc.generate(buildWords(60), "M2")).toEqual(Buffer.from("wc"));
		expect(r.generateWordCloudImg).toHaveBeenCalledTimes(1);

		// 注入撤销
		current = null;
		expect(await wc.generate(buildWords(60), "M3")).toBeUndefined();
		expect(r.generateWordCloudImg).toHaveBeenCalledTimes(1); // 没新增
	});

	it("isImageEnabled() 返回 false → 即便 provider 有渲染器也跳过", async () => {
		const r = fakeRenderer();
		const wc = new WordcloudGenerator({
			getImageRenderer: () => r,
			isImageEnabled: () => false,
			logger: fakeLogger(),
		});
		const buf = await wc.generate(buildWords(60), "M");
		expect(buf).toBeUndefined();
		expect(r.generateWordCloudImg).not.toHaveBeenCalled();
	});
});

// LiveEngine.setImageRenderer 集成测:LiveEngine 构造 + 子组件透传 + setter
// 后子组件能 read 到新引用。LiveEngine 构造需要一堆 deps,这里 white-box 用 priv
// 拿到内部 wordcloud / listener 子组件,断言其 imageRenderer 同步。

import type { LiveEngine } from "../live-engine";
import { LiveEngine as LiveEngineImpl } from "../live-engine";

describe("LiveEngine — setImageRenderer 与 setCommentary 后置注入", () => {
	const buildEngine = (initialImage: ImageRenderer | null): LiveEngine => {
		const serviceCtx = {
			logger: fakeLogger(),
			bus: { emit: vi.fn(), on: vi.fn() },
			// biome-ignore lint/suspicious/noExplicitAny: 简化 mock,直播引擎构造期不触发监听。
		} as any;
		return new LiveEngineImpl({
			serviceCtx,
			// biome-ignore lint/suspicious/noExplicitAny: 测试白盒,LiveEngine 不会用 api 直到 start。
			api: {} as any,
			// biome-ignore lint/suspicious/noExplicitAny: 同上
			push: {} as any,
			// biome-ignore lint/suspicious/noExplicitAny: 同上
			contentBuilder: {} as any,
			imageRenderer: initialImage,
			commentary: null,
			config: {
				wordcloudStopWords: "",
				pushTime: 0,
				liveSummaryDefault: "",
				customGuardBuy: { enable: false },
				customLiveMsg: { enable: false },
				imageEnabled: true,
				aiEnabled: true,
			},
			emitEngineError: vi.fn(),
		});
	};

	it("setImageRenderer 替换后,内部 WordcloudGenerator provider 自动看到新引用", async () => {
		const engine = buildEngine(null);
		// listener.ctx 上的 imageRenderer getter 应该现取
		// biome-ignore lint/suspicious/noExplicitAny: 测试白盒
		const ctxAny = (engine as any).listener.ctx as { imageRenderer: ImageRenderer | null };
		expect(ctxAny.imageRenderer).toBeNull();

		const r = fakeRenderer();
		engine.setImageRenderer(r);
		expect(ctxAny.imageRenderer).toBe(r);

		engine.setImageRenderer(null);
		expect(ctxAny.imageRenderer).toBeNull();
	});

	it("teardown 走 disposeAll,确保 auth-lost 主动关闭会先 cancel sessions", () => {
		const engine = buildEngine(null);
		// biome-ignore lint/suspicious/noExplicitAny: 测试白盒
		const listener = (engine as any).listener as {
			disposeAll: () => void;
			clearListeners: () => void;
		};
		const disposeAll = vi.spyOn(listener, "disposeAll").mockImplementation(() => {});
		const clearListeners = vi.spyOn(listener, "clearListeners").mockImplementation(() => {});

		engine.teardown();

		expect(disposeAll).toHaveBeenCalledTimes(1);
		expect(clearListeners).not.toHaveBeenCalled();
	});

	it("setCommentary 后,内部 LiveSummaryRequester 实际收到新 commentary 引用", () => {
		const engine = buildEngine(null);
		// biome-ignore lint/suspicious/noExplicitAny: 测试白盒
		const requester = (engine as any).liveSummaryRequester as {
			commentary: CommentaryGenerator | null;
		};
		expect(requester.commentary).toBeNull();

		// biome-ignore lint/suspicious/noExplicitAny: mock
		const ai = { comment: vi.fn() } as any as CommentaryGenerator;
		engine.setCommentary(ai);
		expect(requester.commentary).toBe(ai);

		engine.setCommentary(null);
		expect(requester.commentary).toBeNull();
	});
});
