/**
 * `@bilibili-notify/extension/build` —— **拓展构建时用的那一面**,只给拓展的 `vite.config.ts` 用。
 *
 * 规则只写一份:拓展入口导出 `settingsSchema` / `connectionSettingsSchema`,构建照规则把设置项写进
 * `dist/extension.json`,源码清单里不写第二份。本体住 `@bilibili-notify/internal/extension/build`,这里只转出。
 *
 * ⛔ 拓展的 `src/` 不许 import 这一面:它带着宿主的代码(读规则、对表、清单格式),打进拓展包就是一份
 * 宿主代码的拷贝。守卫在 `extension-import-boundary.test.ts`。
 */

export type { ExtensionEntrySchemas } from "@bilibili-notify/internal/extension/build";
export {
	extensionPackageFiles,
	manifestWithSettingsFields,
} from "@bilibili-notify/internal/extension/build";
