import type { UpdateStatusDTO } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { newerVersionOf, phaseLabel, updateRefetchInterval } from "../status";

function status(state: UpdateStatusDTO["state"]): UpdateStatusDTO {
	return { currentVersion: "0.8.0", rollbackTarget: null, pinnedVersion: null, state };
}

describe("newerVersionOf —— 「有一版比现在新」这件事只在一处判", () => {
	it("有新版 / 正在下 / 已就绪 / 要新镜像:都算有新版,给版本号", () => {
		const t = (state: UpdateStatusDTO["state"]) => newerVersionOf(status(state));
		expect(t({ phase: "available", target: "0.9.0", releaseUrl: "https://x", checkedAt: 1 })).toBe(
			"0.9.0",
		);
		expect(t({ phase: "downloading", target: "0.9.0", releaseUrl: "https://x" })).toBe("0.9.0");
		expect(t({ phase: "ready", target: "0.9.0", releaseUrl: "https://x" })).toBe("0.9.0");
		expect(
			t({ phase: "needs-image-pull", target: "0.9.0", releaseUrl: "https://x", checkedAt: 1 }),
		).toBe("0.9.0");
	});

	it("回退目标不是「新版」—— 它比现在旧,别把它当更新去提示", () => {
		expect(newerVersionOf(status({ phase: "rolled-back", target: "0.7.0" }))).toBeNull();
	});

	it("没查过 / 最新 / 关着 / 出错:没有", () => {
		expect(newerVersionOf(status({ phase: "idle" }))).toBeNull();
		expect(newerVersionOf(status({ phase: "up-to-date", checkedAt: 1 }))).toBeNull();
		expect(newerVersionOf(status({ phase: "disabled" }))).toBeNull();
		expect(
			newerVersionOf(status({ phase: "error", reason: "unreachable", checkedAt: 1 })),
		).toBeNull();
	});
});

describe("phaseLabel", () => {
	it("每个阶段都有一句人话,而且带版本号的阶段把版本号说出来", () => {
		expect(
			phaseLabel(status({ phase: "ready", target: "0.9.0", releaseUrl: "https://x" })),
		).toContain("0.9.0");
		expect(phaseLabel(status({ phase: "idle" }))).toBe("还没查过");
	});
});

describe("updateRefetchInterval", () => {
	it("正在下载时轮询,别的阶段不轮询,没数据也不轮询", () => {
		// 后台自动下载期间进系统页会卡在「正在下载」:没有轮询、窗口聚焦也不刷新、
		// 也没有 WS 频道推这件事 —— 不按检查更新它就永远不动。
		expect(
			updateRefetchInterval(
				status({ phase: "downloading", target: "0.9.0", releaseUrl: "https://x" }),
			),
		).toBe(2_000);
		expect(
			updateRefetchInterval(status({ phase: "ready", target: "0.9.0", releaseUrl: "https://x" })),
		).toBe(false);
		expect(updateRefetchInterval(status({ phase: "idle" }))).toBe(false);
		expect(updateRefetchInterval(undefined)).toBe(false);
	});
});
