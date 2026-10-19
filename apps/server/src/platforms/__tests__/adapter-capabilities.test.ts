/**
 * 三个内置适配器对「@全体 / 收不收得到回复 / 小程序卡」的回答。
 *
 * 这几格从前是 `PLATFORM_REGISTRY` 里写死的两列(`atAll` / `inbound`)。改成问适配器之后,
 * 回答必须**逐格等于旧表**:onebot `inbound:true, atAll:true`;qq-official `inbound:true,
 * atAll:false`;四个 webhook 平台 `inbound:false, atAll:true`。对不上就是行为变了。
 */

import type { Connection, PlatformAdapter, ServiceContext } from "@bilibili-notify/internal";
import { platformDescriptor } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
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

describe("内置适配器的 atAll / inbound 回答(逐格等于旧平台表)", () => {
	it("onebot:atAll 支持、inbound 支持", () => {
		const adapter = createOnebotAdapter({ logger: makeLogger(), serviceCtx: makeServiceCtx() });
		const caps = capsOf(adapter, "onebot");
		expect(caps.atAll.state).toBe("supported");
		expect(caps.inbound.state).toBe("supported");
		// 小程序卡仍是「没探过 = 还不知道」,这一片不动它。
		expect(caps.nativeShare.state).toBe("unknown");
	});

	it("qq-official:atAll 不支持(带原因)、inbound 支持、nativeShare 不支持(带原因)", () => {
		const adapter = createQQOfficialAdapter({
			logger: makeLogger(),
			serviceCtx: makeServiceCtx(),
			registry: createQQSessionRegistry(),
		});
		const caps = capsOf(adapter, "qq-official");
		expect(caps.atAll).toMatchObject({
			state: "unsupported",
			reason: "QQ 官方机器人在群里 @全体 要特殊权限，适配器会丢掉 @全体 段",
		});
		expect(caps.inbound.state).toBe("supported");
		expect(caps.nativeShare.state).toBe("unsupported");
		expect(caps.nativeShare.state === "unsupported" && caps.nativeShare.reason).toBeTruthy();
	});

	it("webhook:atAll 支持、inbound 不支持(原因是没有回程)、nativeShare 不支持", () => {
		const adapter = createWebhookAdapter({ logger: makeLogger() });
		// 四个 webhook 平台共用这一个适配器 —— 回答不看平台,四档都得一样。
		for (const platform of ["feishu", "dingtalk", "wecom", "generic"]) {
			const caps = capsOf(adapter, platform);
			expect(caps.atAll.state).toBe("supported");
			expect(caps.inbound).toMatchObject({
				state: "unsupported",
				reason: "webhook 只是一个出站 HTTP 请求、没有回程，主人没法在上面回话",
			});
			expect(caps.nativeShare.state).toBe("unsupported");
		}
	});
});
