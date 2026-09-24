/**
 * **per-UP 旋钮覆盖的服务端接线**(ADR-0014 决策 17 的 🔗,2026-09-24)。
 *
 * 值住订阅的 `overrides.cardSkinKnobs`(按皮肤 id 分),出图时在渲染器里与全局那份逐枚合并。
 * 服务端要做的只有一件事:把这位 UP 那一层**原样**递到出卡那一刻 —— B 站的直播 / 动态视图、
 * 拓展订阅的直播 / 作品设置,四条路各折一次。这里钉两件事:
 *
 * 1. 四条路的视图 / 设置都带上它,而且**只带 per-UP 那层、不折全局**(全局随渲染器 config
 *    热更;折进 B 站动态引擎那份快照,全局再改就改不动这位 UP 了 —— 与 `customCardStyle`
 *    「不伪装全局值」同一条,见 `sub-views.test.ts`);
 * 2. 一路走到真渲染器:拓展订阅的开播卡上,这位 UP 选的**字体文件与壁纸**真读了盘、进了 HTML ——
 *    这两档「别的旋钮都生效、唯独它俩静静不动」栽过一回(2026-09-19)。
 *
 * 验红:把 `engines.ts` 里 `liveWorkSettings` / `dynamicWorkSettings` 递 `cardSkinKnobs` 那一句
 * 任删一句,对应的用例红;删 `extension-live-push.ts` 递它那一句,最后一条红。
 */

import { ImageRenderer, type PuppeteerLike } from "@bilibili-notify/image";
import {
	type BiliSubscription,
	DEFAULT_CARD_SKIN_ID,
	type GlobalConfig,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type ServiceContext,
	type Subscription,
} from "@bilibili-notify/internal";
import type { LiveNotifySend } from "@bilibili-notify/live";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import {
	buildDynamicSubsView,
	buildLiveSubViewSingle,
	dynamicWorkSettings,
	liveWorkSettings,
} from "../engines.js";
import { createExtensionLiveTable } from "../extension-live.js";
import { bindExtensionLivePush } from "../extension-live-push.js";
import { createNodeMessageBus } from "../message-bus.js";
import type { SubRuntimeStore } from "../sub-runtime-store.js";

const PER_UP = {
	[DEFAULT_CARD_SKIN_ID]: { "gradient-start": "#aaaaaa", font: "upload:f9", wallpaper: ["bgU"] },
	cyberpunk: { neon: "#00f0ff" },
};

function globalsWith(knobs: GlobalConfig["defaults"]["cardSkinKnobs"] = {}): GlobalConfig {
	const g = makeDefaultGlobalConfig();
	g.defaults.cardSkinKnobs = knobs;
	return g;
}

const biliSub = (overrides: Subscription["overrides"] = {}): BiliSubscription => ({
	...makeEmptySubscription({ id: "11111111-1111-4111-8111-111111111111", uid: "12345" }),
	enabled: true,
	overrides,
});

const fakeRuntimeStore = (): SubRuntimeStore =>
	({
		get: () => undefined,
		// biome-ignore lint/suspicious/noExplicitAny: 测试只用 get
	}) as any;

const fakeStore = (subs: Subscription[]): SubscriptionStore =>
	({
		list: () => subs,
		// biome-ignore lint/suspicious/noExplicitAny: 测试只用 list
	}) as any;

describe("订阅视图 / 设置带上这位 UP 那一层旋钮覆盖", () => {
	it("B 站订阅:直播视图与动态视图都原样带着 overrides.cardSkinKnobs", () => {
		const sub = biliSub({ cardSkinKnobs: PER_UP });
		const g = globalsWith({ [DEFAULT_CARD_SKIN_ID]: { "gradient-end": "#222222" } });
		expect(buildLiveSubViewSingle(sub, fakeRuntimeStore(), g).cardSkinKnobs).toEqual(PER_UP);
		expect(
			buildDynamicSubsView(fakeStore([sub]), fakeRuntimeStore(), g)["12345"]?.cardSkinKnobs,
		).toEqual(PER_UP);
	});

	/**
	 * 全局拧过、这位 UP 没单独拧 → 视图里**没有**这一格。折进去的话 B 站动态引擎那份快照就把
	 * 全局值冻住了:全局再拧,这位 UP 的卡纹丝不动。验红:把 `dynamicWorkSettings` 里那一格改成
	 * `sub.overrides.cardSkinKnobs ?? globals.defaults.cardSkinKnobs`,这条红。
	 */
	it("没单独拧过 → 视图里没有这一格,即便全局拧过(全局由渲染器 config 热更)", () => {
		const sub = biliSub();
		const g = globalsWith({ [DEFAULT_CARD_SKIN_ID]: { "gradient-end": "#222222" } });
		expect(buildLiveSubViewSingle(sub, fakeRuntimeStore(), g).cardSkinKnobs).toBeUndefined();
		expect(
			buildDynamicSubsView(fakeStore([sub]), fakeRuntimeStore(), g)["12345"]?.cardSkinKnobs,
		).toBeUndefined();
	});

	it("拓展订阅:直播设置与作品设置都带着", () => {
		const sub = makeExtensionSubscription({ overrides: { cardSkinKnobs: PER_UP } });
		const g = globalsWith();
		expect(liveWorkSettings(sub, g).cardSkinKnobs).toEqual(PER_UP);
		expect(dynamicWorkSettings(sub, g).cardSkinKnobs).toEqual(PER_UP);
	});
});

// ── 一路走到真渲染器 ─────────────────────────────────────────────────────────

const SERVICE_CTX: ServiceContext = {
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	setInterval: () => ({ dispose() {} }),
	setTimeout: () => ({ dispose() {} }),
	onDispose: () => {},
};

/** 截图那一步的替身:把灌进去的 HTML 留下来。 */
function fakePuppeteer(captured: string[]): PuppeteerLike {
	const page = {
		setContent: async (html: string) => {
			captured.push(html);
		},
		waitForFunction: async () => undefined,
		$: async () => ({
			boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
			dispose: async () => {},
		}),
		screenshot: async () => Buffer.from("fake-jpeg"),
		close: async () => {},
	};
	return { page: async () => page } as unknown as PuppeteerLike;
}

describe("拓展订阅的开播卡:per-UP 那层一路画进卡里", () => {
	const disposers: Array<{ dispose(): void }> = [];
	afterEach(() => {
		for (const d of disposers.splice(0)) d.dispose();
	});

	it("这位 UP 选的字体文件与壁纸真读了盘进了 HTML,没单独拧的那枚跟着全局", async () => {
		const sub = makeExtensionSubscription({ overrides: { cardSkinKnobs: PER_UP } });
		// 全局拧了两枚:起色被这位 UP 盖掉,止色他没动 → 照全局。
		const g = globalsWith({
			[DEFAULT_CARD_SKIN_ID]: { "gradient-start": "#111111", "gradient-end": "#222222" },
		});
		const captured: string[] = [];
		const renderer = new ImageRenderer({
			serviceCtx: SERVICE_CTX,
			puppeteer: fakePuppeteer(captured),
			config: { cardSkinKnobs: g.defaults.cardSkinKnobs },
			resolveAsset: async (id) => `data:image/png;base64,${id}`,
			resolveFontFace: async (id) => `@font-face{font-family:"bn-user-font";src:url("${id}")}`,
		});

		const bus = createNodeMessageBus();
		const timers = {
			setTimeout: (fn: () => void, ms: number) => {
				const h = setTimeout(fn, ms);
				return { dispose: () => clearTimeout(h) };
			},
			setInterval: (fn: () => void, ms: number) => {
				const h = setInterval(fn, ms);
				return { dispose: () => clearInterval(h) };
			},
		};
		const table = createExtensionLiveTable({ bus, timers });
		disposers.push(table);
		let delivered!: () => void;
		const sent = new Promise<void>((resolve) => {
			delivered = resolve;
		});
		disposers.push(
			bindExtensionLivePush({
				bus,
				logger: SERVICE_CTX.logger,
				table,
				subscription: (id) => (id === sub.id ? sub : undefined),
				profile: () => ({ name: "抖音甲" }),
				settings: (s) => liveWorkSettings(s, g),
				cardStyle: () => undefined,
				sources: { running: () => true, readAvatar: async () => undefined },
				sendFor: (): LiveNotifySend => async () => delivered(),
				renderer: () => renderer,
				reportProblem: () => {},
				timers,
			}),
		);

		bus.emit("subscription-reported", {
			extensionId: sub.extensionId,
			externalId: sub.externalId,
			subscriptionIds: [sub.id],
			report: {
				kind: "liveStart",
				value: { url: "https://live.example/1", startedAt: Date.now(), title: "第一场" },
			},
		});
		await sent;

		const html = captured[0] ?? "";
		expect(html).toContain('@font-face{font-family:"bn-user-font";src:url("f9")}');
		expect(html).toContain("--bn-knob-gradient-start:#aaaaaa");
		expect(html).not.toContain("#111111");
		expect(html).toContain("--bn-knob-gradient-end:#222222");
		// 值里的引号在 inline style 属性里转成了 `&quot;`。
		expect(html).toContain(
			"--bn-knob-wallpaper:url(&quot;data:image/png;base64,bgU&quot;) center / cover",
		);
	});
});
