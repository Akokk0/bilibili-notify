/**
 * **真装配里,集成经上下文存的图登记成了图库的一家「集成在途」**(接线守卫,同 `post-images-wiring.test.ts`;
 * ADR-0025 决策 8)。
 *
 * 集成的 `ctx.fetchImage` / `ctx.storeImage` 存下的图在集成手里只是引用,落进历史行、资料缓存之类才有人认领,所以这一家
 * 登记时名单恒空 —— 图靠宽限期活到被认领,过了宽限期没人引用,下一轮清扫收走。登记那一行写歪(没登记、名单写成
 * 永远引用)症状都是静默的,单测证明不了,所以这里走真的 `createAppRuntime`:
 *
 * - 这一家在册(同名再登记当场抛);
 * - 存进去的图,宽限期内清扫不删;过了宽限期没人引用,下一轮收走(不永久占盘)。
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { putImage } from "../../__tests__/support/chat-images.js";
import { png } from "../../__tests__/support/report-images.js";
import { settingsSegment } from "../../bilibili/settings.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { IMAGE_REFERRERS } from "../../images/image-referrers.js";
import { IMAGE_GRACE_MS } from "../../images/image-store.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";
import { dataPath } from "../roots.js";

let dataDir: string;
let runtime: AppRuntime;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-transit-images-wiring-"));
	runtime = createAppRuntime(
		BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }),
		{ dataRoot: dataDir },
		{ integrationSettings: [settingsSegment] },
	);
});
afterEach(async () => {
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

/** 清扫的时钟:`now` 由调用方给,测试里不依赖真时间的流逝。 */
const justAfter = (ms: number) => new Date(Date.now() + ms);
const imagesOnDisk = async () => (await readdir(dataPath(dataDir, "images"))).sort();

describe("createAppRuntime 里的集成在途图", () => {
	// 验红:`bootstrap.ts` 里不登记这一家(`transitImages` 换成别家的写口),这条红。
	it("「集成在途」是图库的一家引用方:同名再登记当场抛", () => {
		expect(() =>
			runtime.imageStore.register({ name: IMAGE_REFERRERS.inTransit, listRefs: async () => [] }),
		).toThrow();
	});

	// 验红:这一家的名单写成永远引用(`listRefs` 返回别家的名单),过了宽限期那一段红。
	it("存进去的图,宽限期内清扫不删;过了宽限期没人引用,下一轮收走", async () => {
		const ref = await putImage(runtime.transitImages, png(10, 10));

		const early = await runtime.imageStore.sweep({
			now: justAfter(IMAGE_GRACE_MS - 60 * 60 * 1000),
		});
		expect(early).toEqual({ removed: [], removedBytes: 0, referenced: 0, inGrace: 1 });
		expect(await imagesOnDisk()).toEqual([ref]);

		const late = await runtime.imageStore.sweep({
			now: justAfter(IMAGE_GRACE_MS + 60 * 60 * 1000),
		});
		expect(late.removed).toEqual([ref]);
		expect(await imagesOnDisk()).toEqual([]);
	});
});
