/**
 * **来源声明的图由运行时登记,名单现读来源登记表里的描述符**。
 *
 * 描述符里的档位引用会在运行中补上;漏掉 `bootstrap.ts` 的登记,或者把名单在启动时拷死,
 * 症状都是当天一切正常、过了宽限期后清扫把仍在用的徽章收走。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceContext, SourceDescriptor } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { putImage } from "../../__tests__/support/chat-images.js";
import { noCandidates, noProfile } from "../../__tests__/support/no-candidates.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { IMAGE_REFERRERS } from "../../images/image-referrers.js";
import { IMAGE_GRACE_MS } from "../../images/image-store.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";

let dataDir: string;
let runtime: AppRuntime;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-source-declared-images-"));
	runtime = createAppRuntime(
		BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }),
		{ dataRoot: dataDir },
		{ integrationSettings: [] },
	);
});

afterEach(async () => {
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

const afterGrace = () => new Date(Date.now() + IMAGE_GRACE_MS + 60 * 60 * 1000);

describe("来源声明的图", () => {
	it("名单现读登记表里的描述符:补上的引用在宽限期后仍留住,撤掉后才收走", async () => {
		const ref = await putImage(runtime.transitImages, PNG_BYTES);
		const descriptor: SourceDescriptor = {
			label: "测试来源",
			supportedFeatures: ["post"],
			membershipPrograms: [
				{
					id: "guard",
					name: "测试会员",
					tiers: [{ key: "captain", name: "档", rank: 1, icon: { ref } }],
				},
			],
		};
		await runtime.sourceRegistry.register(
			"bilibili",
			{
				descriptor,
				searchCreators: noCandidates,
				fetchProfile: noProfile,
				start: async () => {},
				stop: async () => {},
			},
			{} as SourceContext,
		);

		expect(await runtime.imageStore.sweep({ now: afterGrace() })).toMatchObject({
			removed: [],
			referenced: 1,
		});
		const usage = await runtime.imageStore.usage();
		expect(usage.find((row) => row.ref === ref)?.holders).toEqual([IMAGE_REFERRERS.sourceDeclared]);

		const tiers = descriptor.membershipPrograms?.[0]?.tiers;
		const firstTier = Array.isArray(tiers) ? tiers[0] : undefined;
		if (firstTier) delete firstTier.icon;
		expect((await runtime.imageStore.sweep({ now: afterGrace() })).removed).toEqual([ref]);
	});
});
