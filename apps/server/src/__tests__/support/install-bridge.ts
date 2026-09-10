import { access, mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 把仓里那个桥**装**进一个 `<dataDir>/extensions/`。
 *
 * 走的就是开发版与插件市场那条路:装载器只认这一个根、只认 `index.mjs`,所以拓展得以
 * **包的形态**出现在那儿。这里用软链(devtools 装的时候也是软链),盘上零拷贝。
 *
 * ⚠️ 要先构建过桥(`vp run -F @bilibili-notify/extension-bridge build`)。CI 的门禁
 * 顺序是 build 在 test 之前,本地漏了会看到下面那句 —— **刻意不静默跳过**:这两条 e2e
 * 正是「桥到底装没装上」的守卫,跳过等于守卫不在。
 */
export async function installBridgeInto(dataDir: string): Promise<string> {
	const repoRoot = join(fileURLToPath(dirname(import.meta.url)), "..", "..", "..", "..", "..");
	const dist = join(repoRoot, "extensions", "bridge", "dist");
	try {
		await access(join(dist, "index.mjs"));
	} catch {
		throw new Error(
			`桥还没构建:${dist} 里没有 index.mjs。先跑 vp run -F @bilibili-notify/extension-bridge build`,
		);
	}
	const root = join(dataDir, "extensions");
	await mkdir(root, { recursive: true });
	const at = join(root, "bridge");
	await symlink(dist, at, "dir");
	return at;
}
