import { afterEach, describe, expect, it } from "vite-plus/test";
import { overridableApi } from "../../../devtools/api-overrides.js";
import { createDevtoolsProviderRegistry } from "../../../devtools/providers.js";
import { createNodeMessageBus } from "../../../runtime/message-bus.js";
import type { Api } from "../../api/index.js";
import { observeLiveConnections } from "../../live/protocol/client.js";
import { type BiliDevtoolsDeps, createBiliDevtools } from "../index.js";
import { fakeAuth } from "./support/fake-auth.js";

/**
 * B 站交给 devtools 的那一包(`DevtoolsProvider`):九个场景 + 两个定时、登录状态,
 * 汇进登记表后 id 都带 `bilibili.` 前缀。
 */

function deps(): BiliDevtoolsDeps {
	return {
		api: () => overridableApi({} as Api),
		auth: () => overridableApi(fakeAuth()),
		bus: createNodeMessageBus(),
		subs: () => [],
		dynamic: () => undefined,
		liveRooms: () => undefined,
		profileAvatars: () => undefined,
		healthCheck: () => undefined,
	};
}

afterEach(() => {
	// 工厂会装全局的直播连接观察钩子;测完摘掉,别漏给同进程里的别的测试。
	observeLiveConnections(null);
});

describe("createBiliDevtools", () => {
	it("交出 B 站那十二个场景,id 不带前缀(前缀由宿主加)", () => {
		const ids = createBiliDevtools(deps()).scenarios.map((s) => s.id);
		expect(ids).toEqual([
			"live.start",
			"live.end",
			"live.danmaku",
			"live.superchat",
			"live.guard",
			"live.gift",
			"live.enter",
			"dynamic.post",
			"dynamic.fail",
			"auth.login-state",
			"dynamic.detect-now",
			"auth.health-now",
		]);
	});

	it("经登记表汇总:每个 id 都是 bilibili.<原 id>,一个不带前缀的也没有", () => {
		const providers = createDevtoolsProviderRegistry();
		providers.claim("bilibili", createBiliDevtools(deps()));
		const ids = providers.scenarios().map((s) => s.id);
		expect(ids).toHaveLength(12);
		expect(ids.every((id) => id.startsWith("bilibili."))).toBe(true);
		expect(ids).toContain("bilibili.live.danmaku");
	});
});
