import { installRepoExtensionInto } from "./install-repo-extension.js";

/**
 * 把仓里那个桥**装**进一个 `<dataDir>/extensions/`(软链,路数见 {@link installRepoExtensionInto})。
 *
 * ⚠️ 要先构建过桥(`vp run -F @bilibili-notify/extension-bridge build`),没构建过就抛、不静默跳过:
 * 用它的两条 e2e 正是「桥到底装没装上」的守卫。
 */
export function installBridgeInto(dataDir: string): Promise<string> {
	return installRepoExtensionInto(dataDir, "bridge", "@bilibili-notify/extension-bridge");
}
