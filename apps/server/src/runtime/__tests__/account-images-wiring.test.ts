/**
 * **真装配里,账号头像登记成了图库的一家引用方**(接线守卫,同 `profile-images-wiring.test.ts`)。
 *
 * 名单从来源登记表现读:每个在册来源 `auth.account().avatar`,有就列。漏掉 `bootstrap.ts` 里那一行 `register(…)`
 * (或把名单写成恒空)的症状是一切照常,只有一天以后清扫把还在用的头像当垃圾删了,而门禁全绿。所以这里走真的
 * `createAppRuntime` + 真登记表里登一个假来源:头像被账号引用着,过了宽限期清扫不删;登出之后(账号没了)才收走;
 * 来源没登记 / 没有头像时名单为空、不抛。
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, type SourceAuth } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { putImage } from "../../__tests__/support/chat-images.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { IMAGE_GRACE_MS } from "../../images/image-store.js";
import { makeIntegration } from "../../subscriptions/__tests__/fixtures.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";
import { dataPath } from "../roots.js";
import { classifyImage } from "../storage-usage.js";

let dataDir: string;
let runtime: AppRuntime;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-account-images-wiring-"));
	runtime = createAppRuntime(BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }), {
		dataRoot: dataDir,
	});
});
afterEach(async () => {
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

const afterGrace = () => new Date(Date.now() + IMAGE_GRACE_MS + 60 * 60 * 1000);
const imagesOnDisk = () => readdir(dataPath(dataDir, "images"));

function authWith(account: () => { name: string; avatar?: string } | null): SourceAuth {
	return {
		beginLogin: async () => ok(),
		logout: async () => ok(),
		state: () => ({ status: "logged-out" }),
		account,
		onChange: () => ({ dispose() {} }),
	};
}

async function registerSource(auth?: SourceAuth) {
	await runtime.sourceRegistry.register(
		"bilibili",
		{ descriptor: {}, start: async () => {}, stop: async () => {}, ...(auth ? { auth } : {}) },
		makeIntegration() as never,
	);
}

describe("createAppRuntime 里的账号头像", () => {
	it("在册来源的账号头像被引用着,过了宽限期清扫也不删;账号没了才收走", async () => {
		const ref = await putImage(runtime.accountImages, PNG_BYTES);
		let avatar: string | undefined = ref;
		await registerSource(authWith(() => ({ name: "主人", avatar })));

		const kept = await runtime.imageStore.sweep({ now: afterGrace() });
		expect(kept).toMatchObject({ removed: [], referenced: 1 });
		expect(await imagesOnDisk()).toEqual([ref]);

		avatar = undefined; // 登出:`account()` 回 null / 没有头像
		const swept = await runtime.imageStore.sweep({ now: afterGrace() });
		expect(swept.removed).toEqual([ref]);
	});

	it("没有来源登记、或来源没有登录口 / 没有头像:名单为空、清扫不抛,图只靠宽限期活着", async () => {
		const ref = await putImage(runtime.accountImages, PNG_BYTES);
		expect((await runtime.imageStore.sweep({ now: new Date() })).removed).toEqual([]);

		await registerSource(); // 没有 auth
		await expect(runtime.imageStore.sweep({ now: afterGrace() })).resolves.toMatchObject({
			removed: [ref],
		});
	});

	it("存储占用里账号头像算「其它图片」", async () => {
		const ref = await putImage(runtime.accountImages, PNG_BYTES);
		await registerSource(authWith(() => ({ name: "主人", avatar: ref })));
		const usage = await runtime.imageStore.usage();
		const row = usage.find((u) => u.ref === ref);
		expect(row?.holders).toEqual(["账号头像"]);
		expect(classifyImage(row?.holders ?? [])).toBe("otherImages");
	});
});
