import { describe, expect, it } from "vitest";
import {
	assertBilibiliNotifyInternalsProtocol,
	BILIBILI_NOTIFY_INTERNALS_PROTOCOL,
	isInternalsVersionCompatible,
	isLegacyInternalsCompatible,
	resolveBilibiliNotifyCoreInternals,
	tryResolveBilibiliNotifyCoreInternals,
} from "../internals-protocol";

describe("internals 协议版本范围判定", () => {
	it("当前 REQUIRED [1,2)：接受 v1、拒绝 v2/非数字，legacy 视为 v1 兼容", () => {
		expect(isInternalsVersionCompatible(1)).toBe(true);
		expect(isInternalsVersionCompatible(2)).toBe(false);
		expect(isInternalsVersionCompatible(undefined)).toBe(false);
		expect(isLegacyInternalsCompatible()).toBe(true);
	});

	it("未来 REQUIRED bump 到 [2,3)：legacy 旧 core 与 v1 都被拒、v2 通过、v3 被拒", () => {
		const next = { minInclusive: 2, maxExclusive: 3 };
		expect(isLegacyInternalsCompatible(next)).toBe(false);
		expect(isInternalsVersionCompatible(1, next)).toBe(false);
		expect(isInternalsVersionCompatible(2, next)).toBe(true);
		expect(isInternalsVersionCompatible(3, next)).toBe(false);
	});
});

describe("Koishi internals protocol", () => {
	const protocol = {
		...BILIBILI_NOTIFY_INTERNALS_PROTOCOL,
		coreVersion: "5.0.0-alpha.5",
	};

	it("通过 probeInternals 解析 ready core internals", () => {
		const internals = { protocol, marker: true };
		const core = {
			getInternals: () => null,
			probeInternals: () => ({ ok: true as const, protocol, internals }),
		};

		expect(resolveBilibiliNotifyCoreInternals("bilibili-notify-live", core)).toBe(internals);
	});

	it("把 core 未就绪与版本不匹配拆成不同诊断", () => {
		const core = {
			getInternals: () => null,
			probeInternals: () => ({ ok: false as const, protocol, reason: "api" as const }),
		};

		expect(() => resolveBilibiliNotifyCoreInternals("bilibili-notify-live", core)).toThrow(
			/核心内部实例尚未就绪（缺少 BilibiliAPI/,
		);
	});

	it("拒绝显式不兼容的 internals 协议版本", () => {
		const internals = {
			protocol: {
				...BILIBILI_NOTIFY_INTERNALS_PROTOCOL,
				version: 2,
				coreVersion: "6.0.0",
			},
		};

		expect(() =>
			assertBilibiliNotifyInternalsProtocol("bilibili-notify-dynamic", internals),
		).toThrow(/internals 协议不兼容/);
	});

	it("兼容能通过 v1 token 返回 internals 的旧 core", () => {
		const legacyInternals = { marker: true };
		const core = {
			getInternals: () => legacyInternals,
		};

		expect(resolveBilibiliNotifyCoreInternals("bilibili-notify-ai", core)).toBe(legacyInternals);
	});

	it("tryResolve 在 core 缺失或不兼容时返回 null", () => {
		const badCore = {
			getInternals: () => ({
				protocol: {
					...BILIBILI_NOTIFY_INTERNALS_PROTOCOL,
					version: 2,
					coreVersion: "6.0.0",
				},
			}),
		};

		expect(tryResolveBilibiliNotifyCoreInternals("bilibili-notify-live", null)).toBeNull();
		expect(tryResolveBilibiliNotifyCoreInternals("bilibili-notify-live", badCore)).toBeNull();
	});

	it("tryResolve 不兼容时回调 onUnavailable 并返回 null", () => {
		const badCore = {
			getInternals: () => ({
				protocol: {
					...BILIBILI_NOTIFY_INTERNALS_PROTOCOL,
					version: 2,
					coreVersion: "6.0.0",
				},
			}),
		};
		let captured = "";
		const result = tryResolveBilibiliNotifyCoreInternals("bilibili-notify-live", badCore, (msg) => {
			captured = msg;
		});
		expect(result).toBeNull();
		expect(captured).toMatch(/internals 协议不兼容/);
	});
});
