import type { UpdateStatusDTO } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { newerVersionOf, phaseLabel } from "../status";

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
