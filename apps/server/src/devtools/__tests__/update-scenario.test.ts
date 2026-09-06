import type { UpdateStatusDTO } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import type { UpdateService } from "../../update/service.js";
import { createDevRegistry } from "../registry.js";
import { updateStateScenario } from "../scenarios/update.js";
import { injectableUpdateService } from "../update-injection.js";

/**
 * B1:更新状态 —— 9 相 8 归因全部造得出来。守的是「造出来的每一档都是契约里合法的形状」:
 * 面板按相位挑措辞,缺一个字段(`checkedAt` / `releaseUrl`)就是一处 undefined 渲染。
 */

const REAL: UpdateStatusDTO = {
	currentVersion: "0.0.0-dev",
	rollbackTarget: null,
	pinnedVersion: null,
	state: { phase: "disabled", reason: "dev-build" },
};

function setup() {
	const real: UpdateService = {
		getStatus: () => REAL,
		check: async () => REAL,
		download: async () => REAL,
		rollback: async () => REAL,
		probeMirrors: async () => [],
	};
	const injectable = injectableUpdateService(real);
	const reg = createDevRegistry([updateStateScenario(injectable)]);
	return { reg, service: injectable.service };
}

describe("update.state 场景", () => {
	it("声明:状态组、相位与归因两个枚举齐全", () => {
		const { reg } = setup();
		const [decl] = reg.list();
		expect(decl?.id).toBe("update.state");
		expect(decl?.group).toBe("state");
		const phase = decl?.params.find((p) => p.key === "phase");
		const reason = decl?.params.find((p) => p.key === "reason");
		expect(phase?.kind === "enum" && phase.options.map((o) => o.value)).toEqual([
			"disabled",
			"idle",
			"up-to-date",
			"available",
			"downloading",
			"ready",
			"needs-image-pull",
			"rolled-back",
			"error",
		]);
		expect(reason?.kind === "enum" && reason.options.map((o) => o.value)).toEqual([
			"unreachable",
			"untrusted",
			"malformed",
			"stale-manifest",
			"download-failed",
			"checksum-mismatch",
			"install-failed",
			"nothing-to-roll-back",
		]);
	});

	it("ready:带 target / releaseUrl / notes,别的字段照实", async () => {
		const { reg, service } = setup();
		const res = await reg.run("update.state", { phase: "ready", target: "0.99.0", notes: "假的" });

		expect(service.getStatus()).toEqual({
			...REAL,
			state: {
				phase: "ready",
				target: "0.99.0",
				releaseUrl: "https://github.com/Akokk0/bilibili-notify/releases/tag/v0.99.0",
				notes: "假的",
			},
		});
		expect(res.active).toEqual([{ scenarioId: "update.state", label: "更新状态 → ready 0.99.0" }]);
	});

	it("error:归因照给,checkedAt 是时间戳,helpUrl 指向发布页", async () => {
		const { reg, service } = setup();
		await reg.run("update.state", { phase: "error", reason: "untrusted" });

		const { state } = service.getStatus();
		expect(state).toMatchObject({ phase: "error", reason: "untrusted" });
		expect(state.phase === "error" && typeof state.checkedAt).toBe("number");
		expect(state.phase === "error" && state.helpUrl).toMatch(/releases$/);
	});

	it("available / needs-image-pull / up-to-date 都带 checkedAt;disabled 带 reason", async () => {
		const { reg, service } = setup();
		for (const phase of ["available", "needs-image-pull", "up-to-date"] as const) {
			await reg.run("update.state", { phase });
			const { state } = service.getStatus();
			expect(state.phase).toBe(phase);
			expect("checkedAt" in state && typeof state.checkedAt).toBe("number");
		}
		await reg.run("update.state", { phase: "disabled", disabledReason: "no-keys" });
		expect(service.getStatus().state).toEqual({ phase: "disabled", reason: "no-keys" });
	});

	it("notes 留空就不带这个字段 —— 契约里它是可选的,空串会让面板渲染一行空白", async () => {
		const { reg, service } = setup();
		await reg.run("update.state", { phase: "available", notes: "" });
		expect(service.getStatus().state).not.toHaveProperty("notes");
	});

	it("收摊后回到真状态", async () => {
		const { reg, service } = setup();
		await reg.run("update.state", { phase: "idle" });
		expect(await reg.reset("update.state")).toEqual([]);
		expect(service.getStatus()).toEqual(REAL);
	});
});
