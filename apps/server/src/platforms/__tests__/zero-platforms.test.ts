import { neutralPlatformSnapshot } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { builtinAdapterStubs } from "../../__tests__/support/builtin-adapter-stubs.js";
import {
	ZERO_PLATFORMS,
	zeroNeutralSnapshot,
	zeroPlatform,
} from "../../migration/zero-platforms.js";

/**
 * 迁移里的冻结副本(`migration/zero-platforms.ts`)不 import 活的平台表 —— 活表以后要删,迁移只写一次。
 * 这份测试把冻结副本钉在**今天的**内置适配器上:「迁来的」与「新建的」是同一张脸,
 * 哪天有人改了活表的一格而没想起迁移,红在这里。
 */
describe("迁移的冻结平台表 ≡ 内置适配器的模板候选", () => {
	it("拓展借来的 bot 用的中性占位 ≡ internal 的 neutralPlatformSnapshot", () => {
		for (const platform of ["telegram", "onebot", "x"]) {
			expect(zeroNeutralSnapshot(platform)).toEqual(neutralPlatformSnapshot(platform));
		}
	});

	it("每个内置适配器的模板候选,去掉 platform 以后逐格 ≡ 冻结表里那一行的快照", async () => {
		const seen: string[] = [];
		for (const adapter of builtinAdapterStubs()) {
			const candidates =
				(await adapter.listConnectionCandidates?.(new AbortController().signal)) ?? [];
			expect(candidates.length, adapter.adapterKey).toBeGreaterThan(0);
			for (const { platform: descriptor } of candidates) {
				const { platform, ...snapshot } = descriptor;
				const frozen = zeroPlatform(platform);
				expect(frozen, `冻结表里没有 ${platform}`).toBeDefined();
				expect(snapshot, platform).toEqual(frozen?.snapshot);
				// 负责它的适配器键也一样
				expect(frozen?.adapterKey, platform).toBe(adapter.adapterKey);
				seen.push(platform);
			}
		}
		// 反过来:冻结表里的每个平台都有且只有一个候选在认领
		expect(seen.sort()).toEqual(Object.keys(ZERO_PLATFORMS).sort());
	});
});
