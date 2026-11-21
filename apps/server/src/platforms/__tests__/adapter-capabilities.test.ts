import { platformDescriptor } from "../platform-descriptors.js";
/**
 * 三个内置适配器对「@全体 / 收不收得到回复 / 小程序卡」的回答。
 *
 * 能力由适配器回答；QQ 官方已接入群聊 / 频道 @全体，不能再沿用旧平台表的不支持结论。
 */

import type { Connection, PlatformAdapter, ServiceContext } from "@bilibili-notify/internal";

import { describe, expect, it, vi } from "vite-plus/test";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { fixedLocale } from "../../__tests__/support/fixed-locale.js";
import { createOnebotAdapter } from "../onebot.js";
import { createQQOfficialAdapter, createQQSessionRegistry } from "../qq-official.js";
import { createWebhookAdapter } from "../webhook.js";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeServiceCtx(): ServiceContext {
	return {
		logger: makeLogger(),
		setTimeout(fn, ms) {
			const h = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(h) };
		},
		setInterval(fn, ms) {
			const h = setInterval(fn, ms);
			return { dispose: () => clearInterval(h) };
		},
		onDispose() {},
		signal: new AbortController().signal,
		track: () => {},
	};
}

function direct(platform: string): Connection {
	return {
		id: "c1",
		name: "c1",
		adapterKey: platformDescriptor(platform)?.adapterKey ?? platform,
		platform,
		platformSnapshot: snapshotFor(platform),
		enabled: true,
		settings: platform === "onebot" ? { transport: "ws" } : {},
	} as unknown as Connection;
}

function capsOf(adapter: PlatformAdapter, platform: string) {
	const caps = adapter.capabilities?.(direct(platform));
	if (!caps) throw new Error(`${adapter.adapterKey} 没实现 capabilities`);
	return caps;
}

/** 带时区、以 UTC `Z` 结尾的 ISO —— 宿主交出的能力时刻一律是这种写法。 */
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function expectUtcIso(value: unknown): void {
	if (typeof value !== "string") throw new Error(`checkedAt 不是字符串:${String(value)}`);
	expect(value).toMatch(UTC_ISO);
	expect(new Date(value).toISOString()).toBe(value);
}

describe("内置适配器的 atAll / inbound 回答", () => {
	it("onebot:atAll 支持、inbound 支持", () => {
		const adapter = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		expect(adapter.descriptor().icon).toBe("qq");
		const caps = capsOf(adapter, "onebot");
		expect(caps.atAll.state).toBe("supported");
		expect(caps.inbound.state).toBe("supported");
		if (caps.atAll.state === "supported") expectUtcIso(caps.atAll.checkedAt);
		// 小程序卡仍是「没探过 = 还不知道」,这一片不动它。
		expect(caps.nativeShare.state).toBe("unknown");
	});
	it("OneBot 按 BN 已接入的发送形式回答图片、多图、转发、语音与 Markdown", () => {
		const adapter = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		expect(capsOf(adapter, "onebot")).toMatchObject({
			image: { state: "supported" },
			imageGroup: { state: "supported" },
			forward: { state: "supported" },
			audio: { state: "supported" },
			markdown: { state: "unsupported" },
		});
	});

	it("qq-official:atAll 与 inbound 支持、nativeShare 不支持(带原因)", () => {
		const adapter = createQQOfficialAdapter({
			logger: makeLogger(),
			serviceCtx: makeServiceCtx(),
			registry: createQQSessionRegistry(),
			locale: fixedLocale(),
		});
		expect(adapter.descriptor().icon).toBe("qq");
		const caps = capsOf(adapter, "qq-official");
		expect(caps.atAll.state).toBe("supported");
		if (caps.atAll.state === "supported") expectUtcIso(caps.atAll.checkedAt);
		expect(caps.inbound.state).toBe("supported");
		if (caps.inbound.state === "supported") expectUtcIso(caps.inbound.checkedAt);
		expect(caps.nativeShare.state).toBe("unsupported");
		expect(caps.nativeShare.state === "unsupported" && caps.nativeShare.reason).toBeTruthy();
	});
	it.each(["public", "private"])("QQ %s 机器人报告实际图片与 Markdown 能力", (botType) => {
		const adapter = createQQOfficialAdapter({
			logger: makeLogger(),
			serviceCtx: makeServiceCtx(),
			registry: createQQSessionRegistry(),
			locale: fixedLocale(),
		});
		const connection = { ...direct("qq-official"), settings: { botType } } as Connection;
		expect(adapter.capabilities?.(connection)).toMatchObject({
			image: { state: "supported" },
			imageGroup: { state: "supported" },
			forward: { state: "unsupported" },
			audio: { state: "supported" },
			markdown: { state: botType === "private" ? "supported" : "unsupported" },
		});
	});
	it("只发纯文本的 webhook 不把图片降级冒充图片支持,通用接收端保持未知", () => {
		const adapter = createWebhookAdapter({ logger: makeLogger() });
		for (const platform of ["feishu", "dingtalk", "wecom"]) {
			expect(capsOf(adapter, platform)).toMatchObject({
				image: { state: "unsupported" },
				imageGroup: { state: "unsupported" },
				forward: { state: "unsupported" },
				audio: { state: "unsupported" },
				markdown: { state: "unsupported" },
			});
		}
		expect(capsOf(adapter, "generic")).toMatchObject({
			image: { state: "unknown" },
			markdown: { state: "unknown" },
			audio: { state: "unsupported" },
		});
	});

	it("webhook:纯文本方言不冒充原生艾特全体，通用接收端保持未知", () => {
		const adapter = createWebhookAdapter({ logger: makeLogger() });
		expect(adapter.descriptor().icon).toBe("link");
		// 通用接收端由接收方决定如何呈现；纯文本方言不能用字面文字冒充艾特。
		for (const platform of ["feishu", "dingtalk", "wecom", "generic"]) {
			const caps = capsOf(adapter, platform);
			expect(caps.atAll.state).toBe(platform === "generic" ? "unknown" : "unsupported");
			expect(caps.inbound).toMatchObject({
				state: "unsupported",
				reason: "webhook 只是一个出站 HTTP 请求、没有回程，主人没法在上面回话",
			});
			expect(caps.nativeShare.state).toBe("unsupported");
		}
	});
});
