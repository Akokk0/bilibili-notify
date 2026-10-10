/**
 * 🔴 **数据统计总开关接在装配处**(ADR-0027 决策 9;㉙a)。
 *
 * 记录器(`stats/recorder.ts`)吃一个注入的 `isEnabled()`、粉丝轮询吃 `runtime.isStatsEnabled`,各有直测,
 * 证明不了 `bootstrap.ts` 真的把设置里的 `stats.enabled` 接给了它们 —— 剪断的症状是:开关页上关了、
 * 盘上照记不误,类型与构建全绿。所以起一个真的运行时(真总线、真配置仓、真统计仓),用真的设置写入口改开关,
 * 再从总线上放事件(`post-detected`,统计唯一听的作品事件):
 *   - 开着 → 关着 → 开着,三条作品各隔一次改设置,盘上只该有第一条与第三条(热更新、不重启);
 *   - `runtime.isStatsEnabled()` 跟着同一份设置走(粉丝轮询取的就是它)。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEmptySubscription, type PostEvent } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BootstrapConfig } from "../config/schema.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

const SUB_ID = "b0000000-0000-4000-8000-000000000001";

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("统计总开关 × 装配(createAppRuntime)", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-stats-switch-wiring-"));
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("设置里的 stats.enabled 管着记录器:改设置不重启,下一条动态就按新值", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir), { dataRoot: dataDir });
		await runtime.configStore.load();
		await runtime.configStore.upsertSubscription(
			makeEmptySubscription({
				id: SUB_ID,
				identity: { sourceKey: "bilibili", externalId: "12345" },
			}),
		);
		const dynamic = (id: string): PostEvent => ({
			subscriptionId: SUB_ID,
			identity: { sourceKey: "bilibili", externalId: "12345" },
			postId: id,
			url: `https://t.bilibili.com/${id}`,
			post: { creator: { name: "某人" }, publishedAt: "2026-10-06T09:00:00.000Z", text: "" },
		});
		const recorded = async () =>
			(await runtime.statsStore.listPosts(SUB_ID, "2026-01-01T00:00:00.000Z"))
				.map((p) => p.id)
				.sort();

		runtime.bus.emit("post-detected", dynamic("a"));
		await vi.waitFor(async () => expect(await recorded()).toEqual(["a"]));

		await runtime.configStore.patchGlobals({ stats: { enabled: false } });
		expect(runtime.isStatsEnabled()).toBe(false);
		runtime.bus.emit("post-detected", dynamic("b"));

		await runtime.configStore.patchGlobals({ stats: { enabled: true } });
		expect(runtime.isStatsEnabled()).toBe(true);
		runtime.bus.emit("post-detected", dynamic("c"));

		// 同一个键的写入按顺序排队落:看到 c,就说明排在它前面的 b 已经落过(或被拦下)。
		await vi.waitFor(async () => expect(await recorded()).toContain("c"));
		expect(await recorded()).toEqual(["a", "c"]);
		await runtime.dispose();
	});

	it("出厂开着:没动过设置的新运行时 isStatsEnabled() 是 true", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir), { dataRoot: dataDir });
		await runtime.configStore.load();
		expect(runtime.isStatsEnabled()).toBe(true);
		await runtime.dispose();
	});
});
