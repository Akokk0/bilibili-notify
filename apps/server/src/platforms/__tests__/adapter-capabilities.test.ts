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
		settings: {},
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

	it("webhook:atAll 支持、inbound 不支持(原因是没有回程)、nativeShare 不支持", () => {
		const adapter = createWebhookAdapter({ logger: makeLogger() });
		expect(adapter.descriptor().icon).toBe("link");
		// 四个 webhook 平台共用这一个适配器 —— 回答不看平台,四档都得一样。
		for (const platform of ["feishu", "dingtalk", "wecom", "generic"]) {
			const caps = capsOf(adapter, platform);
			expect(caps.atAll.state).toBe("supported");
			if (caps.atAll.state === "supported") expectUtcIso(caps.atAll.checkedAt);
			expect(caps.inbound).toMatchObject({
				state: "unsupported",
				reason: "webhook 只是一个出站 HTTP 请求、没有回程，主人没法在上面回话",
			});
			expect(caps.nativeShare.state).toBe("unsupported");
		}
	});
});
