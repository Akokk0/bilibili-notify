/**
 * 假桥报的协议版本 **必须与桥的 `contract.ts` 逐字对上**。
 *
 * 为什么要一条专门的守卫:握手判定只看 `major`(协议 §3),所以 minor 停在几年前照样连得上
 * —— 假桥冒充一个老桥,新加的那几格永远走不到,而类型、测试、构建全绿。1.2 → 1.4 三版没人
 * 发现就是这么来的。
 *
 * 🔴 **读原文,不 import**:桥是拓展,核心 import 不到它(`extensions/__tests__/
 * extension-import-boundary.test.ts` 真扫目录钉着这条边)。所以这里把 `contract.ts` 当文本
 * 读、正则抠出那个常量 —— 抠不出来就当场红,别静默变成一条永远通过的规则。
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { PROTOCOL } from "../fake-bridge.js";

const REPO_ROOT = join(fileURLToPath(dirname(import.meta.url)), "..", "..", "..", "..", "..");
const BRIDGE_CONTRACT = join(REPO_ROOT, "extensions", "bridge", "src", "contract.ts");

/** `export const BRIDGE_PROTOCOL_VERSION: BridgeProtocolVersion = { major: 1, minor: 4 };` */
export function parseBridgeProtocolVersion(
	source: string,
): { major: number; minor: number } | undefined {
	const match = source.match(
		/BRIDGE_PROTOCOL_VERSION[^=]*=\s*\{\s*major:\s*(\d+)\s*,\s*minor:\s*(\d+)\s*\}/,
	);
	if (!match?.[1] || !match[2]) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]) };
}

describe("假桥的协议版本", () => {
	it("抠得出桥那边声明的版本 —— 抠不出来的话下面那条就白写了", () => {
		expect(
			parseBridgeProtocolVersion(
				"export const BRIDGE_PROTOCOL_VERSION: BridgeProtocolVersion = { major: 2, minor: 7 };",
			),
		).toEqual({ major: 2, minor: 7 });
		expect(parseBridgeProtocolVersion("改名了 / 挪走了")).toBeUndefined();
	});

	it("与 `extensions/bridge/src/contract.ts` 里的**一模一样**", async () => {
		const declared = parseBridgeProtocolVersion(await readFile(BRIDGE_CONTRACT, "utf8"));
		expect(declared).toBeDefined();
		expect(PROTOCOL).toEqual(declared);
	});
});
