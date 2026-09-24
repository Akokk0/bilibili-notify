/**
 * 拓展作品的消费者(`bindExtensionPosts`,ADR-0019 决策 62 / 67)—— **同一条订阅的作品按到达顺序串行**。
 *
 * 拓展一口气报两条时,两条是两个互不排队的异步上下文,各自出卡、各自发送:第一条出卡慢(图多、
 * 渲染器在排队),第二条就会先送到群里,主人看到的顺序和发布顺序反过来。每条订阅一道串行闸治的就是
 * 这个。闸拿掉,别的测试一条都不会红(e2e 的渲染本来就经浏览器那道全局的闸串着),所以单独钉一条。
 */

import {
	type BoundWorkPush,
	createCardFailureTracker,
	type PushSegment,
} from "@bilibili-notify/dynamic";
import type { ImageRenderer } from "@bilibili-notify/image";
import { defaultMessageKindLayout, type SubscriptionReportValue } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { bindExtensionPosts } from "../extension-posts.js";
import { createNodeMessageBus } from "../message-bus.js";

const SUB = makeExtensionSubscription({ externalId: "sec-uid-1" });
const logger = { debug() {}, info() {}, warn() {}, error() {} };

function post(n: number): SubscriptionReportValue<"post"> {
	return {
		id: `p${n}`,
		url: `https://www.douyin.com/video/p${n}`,
		publishedAt: Date.UTC(2026, 8, 24, 12, n),
		text: `第 ${n} 条`,
	};
}

describe("bindExtensionPosts — 同一条订阅的作品按到达顺序发", () => {
	it("第一条出卡慢、第二条紧跟着到:发出去仍是先一后二", async () => {
		const bus = createNodeMessageBus();
		/** 第一次出卡卡在这儿,由测试放行;之后的都立刻出。 */
		let releaseFirst: () => void = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let renders = 0;
		const image = {
			generateNeutralDynamicCard: vi.fn(async () => {
				if (renders++ === 0) await firstGate;
				return Buffer.from("card");
			}),
		} as unknown as ImageRenderer;
		/** 发出去的每条消息里的链接(卡 + 文案 + 链接合成一条,链接在文字段的末行)。 */
		const sent: string[] = [];
		const push: BoundWorkPush = {
			broadcast: async (segments: PushSegment[]) => {
				const text = segments.find((s) => s.type === "text");
				sent.push(text?.type === "text" ? (text.text.split("\n").pop() ?? "") : "");
			},
			broadcastSequence: async () => {},
		};

		const handle = bindExtensionPosts({
			bus,
			logger,
			subscription: (id) => (id === SUB.id ? SUB : undefined),
			profileName: () => "资料名",
			settings: () => ({
				messageLayout: defaultMessageKindLayout("dynamic"),
				filter: {},
				dynamic: true,
			}),
			sources: {
				running: () => true,
				postNoun: () => "作品",
				readAvatar: async () => undefined,
			},
			pushFor: () => push,
			deliveryConfig: () => ({ imageGroup: { enable: false, forward: false } }),
			deliveryDeps: () => ({
				logger,
				image,
				cardFailures: createCardFailureTracker(),
				sendErrorMsg: async () => {},
				emitEngineError: () => {},
			}),
		});

		for (const n of [1, 2]) {
			bus.emit("subscription-reported", {
				extensionId: SUB.extensionId,
				externalId: SUB.externalId,
				subscriptionIds: [SUB.id],
				report: { kind: "post", value: post(n) },
			});
		}

		// 第一条已经在出卡、卡住了;第二条得在闸后面等着 —— 它这会儿既不该出卡,更不该发出去。
		await vi.waitFor(() => expect(renders).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(sent).toEqual([]);
		expect(renders).toBe(1);

		releaseFirst();
		await vi.waitFor(() => expect(sent).toHaveLength(2));
		expect(sent).toEqual([post(1).url, post(2).url]);
		handle.dispose();
	});
});
