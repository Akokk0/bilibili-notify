import { fail } from "@bilibili-notify/internal";
import { vi } from "vite-plus/test";
import type { ImageWriter } from "../../../../images/image-store.js";
import type { CreateAuthSystemOptions } from "../../index.js";

/**
 * `createAuthSystem` 新收的两样(配置仓读口、账号头像写口)的测试替身:设置全取默认值、不推变化;
 * 头像写口什么都存不进(这些测试不走抓头像那条线)。
 */
export function testAuthDeps(): Pick<CreateAuthSystemOptions, "configStore" | "accountImages"> {
	return {
		configStore: {
			getIntegrationSettings: ((segment: { schema: { parse(input: unknown): unknown } }) =>
				segment.schema.parse({})) as never,
			onChange: () => ({ dispose() {} }),
		},
		accountImages: {
			put: vi.fn(async () => fail("unavailable", "测试里没有图库")),
			keep: vi.fn(async () => false),
		} as unknown as ImageWriter,
	};
}
