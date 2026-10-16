import { fail } from "@bilibili-notify/internal";
import { vi } from "vite-plus/test";
import { ignoredProblems } from "../../../../__tests__/support/ignored-problems.js";
import type { ImageWriter } from "../../../../images/image-store.js";
import type { CreateAuthSystemOptions } from "../../index.js";

/**
 * `createAuthSystem` 新收的两样的测试替身:账号头像写口(什么都存不进,这些测试不走抓头像那条线)和
 * 问题表写口(不收任何问题)。
 */
export function testAuthDeps(): Pick<CreateAuthSystemOptions, "accountImages" | "problems"> {
	return {
		accountImages: {
			put: vi.fn(async () => fail("unavailable", "测试里没有图库")),
			keep: vi.fn(async () => false),
		} as unknown as ImageWriter,
		problems: ignoredProblems,
	};
}
