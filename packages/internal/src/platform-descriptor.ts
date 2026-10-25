/**
 * 零依赖子路径 `@bilibili-notify/internal/platform-descriptor`:造「认不出的平台」用的中性平台描述。
 *
 * 拓展(经 `@bilibili-notify/extension` 转出)与宿主共用这一份 —— 桥借来的 bot 平台是开放词表,
 * 候选里的描述自己造一份,不必抄一份取值。住零依赖的子路径是因为门不能连带 zod:这个文件只许
 * `import type`(`scripts/__tests__/internal-package.test.mjs` 钉着)。
 */

import type { PlatformDescriptor } from "./schema/targets";

/** 中性的平台描述:名字就是平台名,目标按会话算、三种范围都给,地址叫法留空。每次造新的一份。 */
export function neutralPlatformDescriptor(platform: string): PlatformDescriptor {
	return {
		platform,
		label: platform,
		shortLabel: platform,
		color: "#94a3b8",
		targetKind: "session",
		scopes: ["group", "private", "channel"],
		addressNouns: {},
	};
}
