/**
 * 「这个推送目标算不算暂停」—— 服务端跳过它、面板标「已停用」,说的必须是同一件事。
 *
 * 判定住在 internal 就是为了这个:前端只看 `target.enabled` 的话,适配器停用的目标在
 * 选择器里显示为启用,发的时候却被跳过。
 */

import { describe, expect, it } from "vite-plus/test";
import { isTargetPaused } from "./constants";

const adapters = [
	{ id: "a-on", enabled: true },
	{ id: "a-off", enabled: false },
];

describe("isTargetPaused", () => {
	it("目标自己关了 → 暂停", () => {
		expect(isTargetPaused({ enabled: false, adapterId: "a-on" }, adapters)).toBe(true);
	});

	it("目标开着但适配器停用 → 也算暂停(投递层对它回不可达)", () => {
		expect(isTargetPaused({ enabled: true, adapterId: "a-off" }, adapters)).toBe(true);
	});

	it("适配器压根不在配置里(被删了)→ 暂停", () => {
		expect(isTargetPaused({ enabled: true, adapterId: "gone" }, adapters)).toBe(true);
	});

	it("两头都开着才不算暂停", () => {
		expect(isTargetPaused({ enabled: true, adapterId: "a-on" }, adapters)).toBe(false);
	});
});
