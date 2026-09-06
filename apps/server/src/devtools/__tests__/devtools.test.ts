import type { UpdateStatusDTO } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import type { UpdateService } from "../../update/service.js";
import { createDevtools } from "../index.js";

/**
 * devtools 那道门 = **载荷版本号是不是开发版**。不是环境变量:环境变量能在生产镜像里被
 * 设上,版本号不能;alpha 也不给 —— 它是发出去给人用的构建。
 */

const REAL: UpdateStatusDTO = {
	currentVersion: "0.0.0-dev",
	rollbackTarget: null,
	pinnedVersion: null,
	state: { phase: "disabled", reason: "dev-build" },
};

const updateService: UpdateService = {
	getStatus: () => REAL,
	check: async () => REAL,
	download: async () => REAL,
	rollback: async () => REAL,
	probeMirrors: async () => [],
};

describe("createDevtools", () => {
	it.each(["0.0.0-dev", "dev"])("开发版 %s → 给", (payloadVersion) => {
		expect(createDevtools({ payloadVersion, updateService })).not.toBeNull();
	});

	it.each(["0.10.0", "0.11.0-alpha.1", "1.0.0-rc.1"])("发出去的版本 %s → 不给", (v) => {
		expect(createDevtools({ payloadVersion: v, updateService })).toBeNull();
	});

	it("给的那份:更新服务换成了可注入的装饰器,注册表里有 update.state", async () => {
		const dev = createDevtools({ payloadVersion: "0.0.0-dev", updateService });
		if (dev === null) throw new Error("unreachable");

		expect(dev.registry.list().map((s) => s.id)).toContain("update.state");
		await dev.registry.run("update.state", { phase: "idle" });
		expect(dev.updateService.getStatus().state).toEqual({ phase: "idle" });
		// 真服务没被动过。
		expect(updateService.getStatus().state).toEqual({ phase: "disabled", reason: "dev-build" });
	});
});
