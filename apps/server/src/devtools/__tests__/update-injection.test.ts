import type { UpdateStatusDTO } from "@bilibili-notify/contract";
import { describe, expect, it, vi } from "vite-plus/test";
import type { UpdateService } from "../../update/service.js";
import { injectableUpdateService } from "../update-injection.js";

/**
 * 更新状态注入 —— devtools 的 B1:面板看到的那份 `state` 换成假的,更新服务本体一行不动。
 *
 * 规矩只有两条:① 只换 `state`,`currentVersion` / `rollbackTarget` / `pinnedVersion`
 * 照实报;② 真动作(检查 / 下载 / 回退)原样转发、**不碰注入** —— 面板每次打开都自动
 * `check()` 一次,真动作要是能顶掉假状态,刷新一下页面注入就没了,「打开面板弹有新版」
 * 这条最想看的路反而永远走不到。收摊只有 devtools 那一个口。
 */

const REAL: UpdateStatusDTO = {
	currentVersion: "0.0.0-dev",
	rollbackTarget: null,
	pinnedVersion: null,
	state: { phase: "disabled", reason: "dev-build" },
};

function fakeService(): UpdateService & { check: ReturnType<typeof vi.fn> } {
	return {
		getStatus: () => REAL,
		check: vi.fn(async () => REAL),
		download: async () => REAL,
		rollback: async () => REAL,
		probeMirrors: async () => [],
	};
}

describe("injectableUpdateService", () => {
	it("没注入时原样转发", () => {
		const { service } = injectableUpdateService(fakeService());
		expect(service.getStatus()).toEqual(REAL);
	});

	it("注入后只换 state,别的字段照实报", () => {
		const { service, inject } = injectableUpdateService(fakeService());
		inject({ phase: "ready", target: "0.99.0", releaseUrl: "https://x/r" });
		expect(service.getStatus()).toEqual({
			...REAL,
			state: { phase: "ready", target: "0.99.0", releaseUrl: "https://x/r" },
		});
	});

	it("真动作照常转发,假状态留着 —— 打开面板那次自动 check 不该把注入抹掉", async () => {
		const real = fakeService();
		const { service, inject, injected } = injectableUpdateService(real);
		inject({ phase: "up-to-date", checkedAt: 1 });

		const fromAction = await service.check();

		expect(real.check).toHaveBeenCalledOnce();
		// 动作的响应也是装饰过的 —— 面板会把它直接写进缓存,回真的就等于把假的冲掉。
		expect(fromAction.state).toEqual({ phase: "up-to-date", checkedAt: 1 });
		expect(injected()).toEqual({ phase: "up-to-date", checkedAt: 1 });
		expect(service.getStatus().state).toEqual({ phase: "up-to-date", checkedAt: 1 });
	});

	it("收摊后回到真状态", () => {
		const { service, inject, clear } = injectableUpdateService(fakeService());
		inject({ phase: "idle" });
		clear();
		expect(service.getStatus()).toEqual(REAL);
	});
});
