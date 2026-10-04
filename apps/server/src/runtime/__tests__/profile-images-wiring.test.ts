/**
 * **真装配里,订阅资料登记成了图库的一家引用方**(接线守卫,同 `chat-images-wiring.test.ts`)。
 *
 * 资料缓存仓的 `listImageRefs` 与图库的清扫各有各的测试,可证明不了 `bootstrap.ts` 里那一行 `register(…)` 真的写上了:
 * 漏掉的症状是一切照常,只有一天以后清扫把还在资料里的头像当垃圾删了,而门禁全绿。所以这里走真的
 * `createAppRuntime`:头像被资料引用着,过了宽限期清扫不删;订阅被丢掉、资料里没了这条,下一轮清扫才收走 ——
 * 这也是订阅删除之后头像文件的去路(没有「删订阅顺手删头像文件」那一步了)。另一条订阅还引用着同一张图时不删。
 *
 * `createAppRuntime` 这一层没人听 `subscription-changed` 去丢资料缓存(那在 `index.ts` 的 FansPoller 和开机的
 * `pruneOrphanSubRuntime`),所以这里直接用 `prune` 替它丢。
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { putImage } from "../../__tests__/support/chat-images.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { IMAGE_GRACE_MS } from "../../images/image-store.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";
import { dataPath } from "../roots.js";

const SUB_A = "e0000000-0000-4000-8000-000000000001";
const SUB_B = "e0000000-0000-4000-8000-000000000002";

let dataDir: string;
let runtime: AppRuntime;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-profile-images-wiring-"));
	runtime = createAppRuntime(BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }), {
		dataRoot: dataDir,
	});
	await runtime.subRuntimeStore.load();
});
afterEach(async () => {
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

/** 宽限期过了:清扫按「一天多以后」的时钟算。 */
const afterGrace = () => new Date(Date.now() + IMAGE_GRACE_MS + 60 * 60 * 1000);
const imagesOnDisk = () => readdir(dataPath(dataDir, "images"));
const profileWith = (avatar: string) => ({
	name: "拓展甲",
	avatar,
	sign: "",
	lastRefreshedAt: "2026-10-04T00:00:00.000Z",
});

describe("createAppRuntime 里的订阅资料头像", () => {
	it("资料缓存引用着的头像,过了宽限期清扫也不删;订阅被丢掉,下一轮才收走", async () => {
		const ref = await putImage(runtime.profileImages, PNG_BYTES);
		await runtime.subRuntimeStore.patch(SUB_A, { cachedProfile: profileWith(ref) });

		const kept = await runtime.imageStore.sweep({ now: afterGrace() });
		expect(kept).toMatchObject({ removed: [], referenced: 1 });
		expect(await imagesOnDisk()).toEqual([ref]);

		await runtime.subRuntimeStore.prune([]);
		const swept = await runtime.imageStore.sweep({ now: afterGrace() });
		expect(swept.removed).toEqual([ref]);
		expect(await imagesOnDisk()).toEqual([]);
	});

	it("另一条订阅还引用着同一张图:这条被丢掉,图不删;两条都没了才收走", async () => {
		const shared = await putImage(runtime.profileImages, PNG_BYTES);
		await runtime.subRuntimeStore.patch(SUB_A, { cachedProfile: profileWith(shared) });
		await runtime.subRuntimeStore.patch(SUB_B, { cachedProfile: profileWith(shared) });

		await runtime.subRuntimeStore.prune([SUB_B]);
		const kept = await runtime.imageStore.sweep({ now: afterGrace() });
		expect(kept).toMatchObject({ removed: [], referenced: 1 });
		expect(await imagesOnDisk()).toEqual([shared]);

		await runtime.subRuntimeStore.prune([]);
		expect((await runtime.imageStore.sweep({ now: afterGrace() })).removed).toEqual([shared]);
	});

	it("B 站订阅的远端网址不是图库的东西:不会让任何一张图被当成还在引用", async () => {
		const ref = await putImage(runtime.profileImages, PNG_BYTES);
		await runtime.subRuntimeStore.patch(SUB_A, {
			cachedProfile: {
				name: "UP",
				avatarUrl: "https://i0.hdslb.com/bfs/face/a.jpg",
				sign: "",
				lastRefreshedAt: "t",
			},
		});

		expect((await runtime.imageStore.sweep({ now: afterGrace() })).removed).toEqual([ref]);
	});
});
