/**
 * **真装配里,大航海徽章图登记成了图库的一家「来源声明的图」**(接线守卫,同 `live-images-wiring.test.ts`;3a-33)。
 *
 * 徽章是运行时从 B 站静态站抓进图库的,不随包带。抓进去之后没有这一家引用方,24 小时后清扫就把三张全收走,
 * 会员卡的徽章块静默收起而门禁全绿。所以走真的 `createAppRuntime`(请求客户端换成假的、不联网):
 *
 * - 抓到之后,过了宽限期清扫也留着三张,图库用量里它们的引用方是「来源声明的图」;
 * - 没引用的野图照常被收走(名单不是写成永远引用);
 * - 抓不到时 `ensure()` 不抛、`iconOf` 给 `undefined`,名单为空。
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@bilibili-notify/http";
import { BILIBILI_GUARD_PROGRAM, fail, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { putImage } from "../../__tests__/support/chat-images.js";
import { png } from "../../__tests__/support/report-images.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { IMAGE_GRACE_MS } from "../../images/image-store.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";
import { dataPath } from "../roots.js";

const TIERS = Array.isArray(BILIBILI_GUARD_PROGRAM.tiers) ? BILIBILI_GUARD_PROGRAM.tiers : [];
let dataDir: string;
let runtime: AppRuntime | undefined;

/** 假的请求客户端:每个徽章地址回一张互不相同的 png;`down` 时回连不上。 */
function fakeHttp(down = false): Pick<HttpClient, "fetch"> {
	return {
		fetch: async (url) => {
			if (down) return fail("unavailable", "连不上");
			const index = TIERS.findIndex((t) => t.icon?.url === String(url));
			const body = png(8, 8, 10 + index);
			return ok({
				url: String(url),
				status: 200,
				headers: new Headers(),
				body,
				isSuccess: true,
				text: () => "",
				json: () => fail("invalid", "不是 json"),
			});
		},
	};
}

function start(guardIconHttp: Pick<HttpClient, "fetch">): AppRuntime {
	runtime = createAppRuntime(
		BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }),
		{ dataRoot: dataDir },
		{ guardIconHttp },
	);
	return runtime;
}

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-guard-icons-wiring-"));
});
afterEach(async () => {
	await runtime?.dispose();
	runtime = undefined;
	await rm(dataDir, { recursive: true, force: true });
});

const PAST_GRACE = IMAGE_GRACE_MS + 60 * 60 * 1000;
const imagesOnDisk = async () => (await readdir(dataPath(dataDir, "images"))).sort();

describe("createAppRuntime 里的大航海徽章图", () => {
	it("抓到的三张,过了宽限期清扫也留着;没人引用的野图照收;用量里的引用方是「来源声明的图」", async () => {
		const rt = start(fakeHttp());
		await rt.guardIcons.ensure();
		const refs = rt.guardIcons.refs();
		expect(refs).toHaveLength(3);
		const stray = await putImage(rt.postImages, png(4, 4, 99));

		// 验红:把 bootstrap.ts 里这一家的名单改成 `async () => []`,三张徽章也被收走,这条红。
		const usage = await rt.imageStore.usage();
		for (const ref of refs) {
			expect(usage.find((u) => u.ref === ref)?.holders).toEqual(["来源声明的图"]);
		}
		const swept = await rt.imageStore.sweep({ now: new Date(Date.now() + PAST_GRACE) });
		expect(swept.removed).toEqual([stray]);
		expect(await imagesOnDisk()).toEqual([...refs].sort());
	});

	it("抓不到:ensure() 不抛、iconOf 给 undefined、名单为空", async () => {
		const rt = start(fakeHttp(true));
		await expect(rt.guardIcons.ensure()).resolves.toBeUndefined();
		expect(rt.guardIcons.iconOf("captain")).toBeUndefined();
		expect(rt.guardIcons.refs()).toEqual([]);
	});
});
