import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/**
 * 官方拓展索引住的那个滚动 release,名字有三处各写一遍:客户端读的地址(`trusted-keys.ts`)、
 * 发版写入的脚本、发版拉「当前」索引的脚本。三处隔着好几天才各跑一次 —— 换名漏一处,不会有
 * 任何东西红,要到下一次发拓展那天才发现:发到了旧 release,新版 BN 读不到。
 * 所以这里去文件里核对三处说的是同一个名字。
 */
describe("官方拓展索引的 release 名三处同源", () => {
	const clientUrl = read("apps/server/src/update/trusted-keys.ts").match(
		/EXTENSION_MARKETPLACE_URL\s*=\s*`[^`]*\/download\/([^/`]+)\/marketplace\.json`/,
	);

	it("客户端地址能解出 release 名", () => {
		expect(clientUrl?.[1]).toBeTruthy();
	});

	it("发版写入的脚本 TAG 与客户端地址里的一致", () => {
		const publish = read(
			".github/scripts/extension-release/publish-extension-marketplace.sh",
		).match(/^export TAG="([^"]+)"$/m);
		expect(publish?.[1]).toBe(clientUrl?.[1]);
	});

	it("拉当前索引的脚本默认 TAG 与客户端地址里的一致", () => {
		const fetchScript = read(".github/scripts/extension-release/fetch-marketplace-index.sh");
		const fallback = fetchScript.match(/^tag="\$\{TAG:-([^}]+)\}"$/m);
		expect(fallback?.[1]).toBe(clientUrl?.[1]);
	});
});
