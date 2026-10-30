import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";
import { BackupPinError } from "../backup/crypto.js";
import { BACKUP_FORMAT, BACKUP_SCHEMA_VERSION, type BackupEnvelope } from "../backup/envelope.js";
import { BackupRejectedError } from "../backup/rejected-error.js";
import type { BackupService } from "../backup/service.js";
import { ConfigValidationError } from "../config/validation-error.js";
import { requestErrorHandler, UNHANDLED_ERROR_MESSAGE } from "../routes/respond-failure.js";
import { createSystemBackupRoute } from "../routes/system-backup.js";

/**
 * /api/system/backup 路由只负责 HTTP 层:解析/校验请求、把已验的信封交给 service、把拒收翻成标准失败形状
 * (ADR-0026:`{ code, message }`,PIN 不对是 `invalid` 不是 `unauthorized`,未知抛错走全局出错处理)。
 * 备份业务逻辑由 service 测试覆盖,这里注入 fake service 只验接线、码与状态码。
 */
function envelope(kind: "full" | "sanitized"): BackupEnvelope {
	return {
		format: BACKUP_FORMAT,
		schemaVersion: BACKUP_SCHEMA_VERSION,
		kind,
		createdAt: "t",
		sections: {},
		...(kind === "full"
			? {
					secrets: {
						kdf: { algo: "scrypt", salt: "x" },
						cipher: { v: 2, iv: "", tag: "", data: "" },
					},
				}
			: {}),
	};
}

function fakeService(over: Partial<BackupService> = {}): BackupService {
	return {
		previewExport: () => ({ defaultedSettings: [] }),
		exportBackup: vi.fn(async () => envelope("sanitized")),
		importBackup: vi.fn(async () => ({
			subscriptions: { upserted: 1, deleted: 0 },
			connections: { upserted: 0, deleted: 0 },
			targets: { upserted: 0, deleted: 0 },
			globalsApplied: false,
			restoredIntegrations: [],
			unrestoredIntegrations: [],
		})),
		...over,
	};
}

it("GET preview contains only defaulted paths and cannot be cached", async () => {
	const { app } = mounted(
		fakeService({ previewExport: () => ({ defaultedSettings: [["core", "ai", "search"]] }) }),
	);
	const response = await app.request("/api/system/backup/preview");
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(await response.json()).toEqual({ defaultedSettings: [["core", "ai", "search"]] });
});

function post(app: ReturnType<typeof createSystemBackupRoute>, path: string, body: unknown) {
	return app.request(path, {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
	});
}

/** 路由挂进带全局出错处理的父实例 —— 与 app.ts 里的挂法一样,未知抛错才会走到那一句固定的话。 */
function mounted(service: BackupService) {
	const logger = { error: vi.fn() };
	const app = new Hono();
	app.onError(requestErrorHandler(logger));
	app.route("/api/system/backup", createSystemBackupRoute({ service }));
	return { app, logger };
}

interface ErrorBody {
	code?: string;
	message?: string;
	issues?: Array<{ path?: unknown[]; message: string }>;
}

describe("backup route", () => {
	it("POST /export returns the envelope from the service", async () => {
		const service = fakeService();
		const app = createSystemBackupRoute({ service });

		const res = await post(app, "/export", {
			kind: "sanitized",
			sections: { subscriptions: true },
		});

		expect(res.status).toBe(200);
		expect(((await res.json()) as { format: string }).format).toBe(BACKUP_FORMAT);
		expect(service.exportBackup).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "sanitized" }),
		);
	});

	it("POST /export rejects a full backup with no PIN", async () => {
		const service = fakeService();
		const app = createSystemBackupRoute({ service });

		const res = await post(app, "/export", { kind: "full" });

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "完整备份必须设置 PIN" });
		expect(service.exportBackup).not.toHaveBeenCalled();
	});

	it("POST /import validates the document and applies it", async () => {
		const service = fakeService();
		const app = createSystemBackupRoute({ service });

		const res = await post(app, "/import", { backup: envelope("sanitized"), mode: "merge" });

		expect(res.status).toBe(200);
		expect(service.importBackup).toHaveBeenCalledWith(expect.objectContaining({ mode: "merge" }));
	});

	it("POST /import forwards dryRun so the dashboard can preview the plan", async () => {
		const service = fakeService();
		const app = createSystemBackupRoute({ service });

		const res = await post(app, "/import", {
			backup: envelope("sanitized"),
			mode: "overwrite",
			dryRun: true,
		});

		expect(res.status).toBe(200);
		expect(service.importBackup).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
	});

	it("POST /import rejects a non-backup document with 400 (never reaches the service)", async () => {
		const service = fakeService();
		const app = createSystemBackupRoute({ service });

		const res = await post(app, "/import", { backup: { hello: "x" }, mode: "overwrite" });

		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorBody;
		expect(body.code).toBe("invalid");
		expect(body.message).toMatch(/不是.*备份文件/);
		expect(service.importBackup).not.toHaveBeenCalled();
	});

	it("POST /import answers a wrong PIN as invalid (400) — never unauthorized, which the panel reads as a dead session", async () => {
		const service = fakeService({
			importBackup: vi.fn(async () => {
				throw new BackupPinError();
			}),
		});
		const app = createSystemBackupRoute({ service });

		const res = await post(app, "/import", {
			backup: envelope("full"),
			pin: "0000",
			mode: "overwrite",
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "备份 PIN 错误，或文件已损坏" });
	});
});

describe("backup route — 请求本身不对", () => {
	it.each([
		["export 体不是合法 JSON", "/export"],
		["import 体不是合法 JSON", "/import"],
	])("%s → invalid", async (_label, path) => {
		const service = fakeService();
		const app = createSystemBackupRoute({ service });

		const res = await app.request(path, {
			method: "POST",
			body: "{not json",
			headers: { "content-type": "application/json" },
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "请求体不是合法的 JSON" });
	});

	it("体是合法 JSON 但不是对象(null / 数组)→ invalid,不再抛 TypeError 变成裸 503", async () => {
		const service = fakeService();
		const { app } = mounted(service);

		for (const body of [null, [1, 2]]) {
			const res = await post(app, "/api/system/backup/export", body);
			expect(res.status).toBe(400);
			expect(((await res.json()) as ErrorBody).code).toBe("invalid");
		}
		expect(service.exportBackup).not.toHaveBeenCalled();
	});

	it("export 的 kind 不认识 → invalid,话里点名两个合法值", async () => {
		const service = fakeService();
		const app = createSystemBackupRoute({ service });

		const res = await post(app, "/export", { kind: "weird" });

		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorBody;
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("full");
		expect(body.message).toContain("sanitized");
		expect(service.exportBackup).not.toHaveBeenCalled();
	});

	it("import 的 mode 不认识 → invalid", async () => {
		const service = fakeService();
		const app = createSystemBackupRoute({ service });

		const res = await post(app, "/import", { backup: envelope("sanitized"), mode: "replace" });

		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorBody;
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("overwrite");
		expect(service.importBackup).not.toHaveBeenCalled();
	});

	it("import 一份完整备份却没带 PIN → invalid,不进服务", async () => {
		const service = fakeService();
		const app = createSystemBackupRoute({ service });

		const res = await post(app, "/import", { backup: envelope("full"), mode: "merge" });

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "完整备份必须设置 PIN" });
		expect(service.importBackup).not.toHaveBeenCalled();
	});

	it("PIN 不是字符串(数字)当没带:不会一路塞进 scrypt 抛 TypeError", async () => {
		const service = fakeService();
		const app = createSystemBackupRoute({ service });

		const res = await post(app, "/export", { kind: "full", pin: 123456 });

		expect(res.status).toBe(400);
		expect(((await res.json()) as ErrorBody).message).toBe("完整备份必须设置 PIN");
		expect(service.exportBackup).not.toHaveBeenCalled();
	});
});

describe("backup route — 备份文件的问题(自带码,话是中文)", () => {
	it("格式版本比当前认得的新 → unsupported(400),话里说清版本号与「请先升级」,不进服务", async () => {
		const service = fakeService();
		const app = createSystemBackupRoute({ service });
		const future = { ...envelope("sanitized"), schemaVersion: BACKUP_SCHEMA_VERSION + 1 };

		const res = await post(app, "/import", { backup: future, mode: "overwrite" });

		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorBody;
		expect(body.code).toBe("unsupported");
		expect(body.message).toContain(String(BACKUP_SCHEMA_VERSION + 1));
		expect(body.message).toContain("升级");
		expect(service.importBackup).not.toHaveBeenCalled();
	});

	it("类型不认识 / 缺版本号 → invalid,原因不带英文机器串也不带 `Error: ` 前缀", async () => {
		const service = fakeService();
		const app = createSystemBackupRoute({ service });
		const { schemaVersion: _dropped, ...noVersion } = envelope("sanitized");

		for (const backup of [{ ...envelope("sanitized"), kind: "weird" }, noVersion]) {
			const res = await post(app, "/import", { backup, mode: "merge" });
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrorBody;
			expect(body.code).toBe("invalid");
			expect(body.message).toMatch(/[一-鿿]/);
			expect(body.message).not.toMatch(/^Error:/);
		}
		expect(service.importBackup).not.toHaveBeenCalled();
	});

	it("服务里抛的 BackupRejectedError(如订阅那节混进了拓展订阅)→ 按它自带的码回", async () => {
		const service = fakeService({
			importBackup: vi.fn(async () => {
				throw new BackupRejectedError(
					"invalid",
					"备份的「订阅」一节里混进了拓展订阅，整份没有恢复",
				);
			}),
		});
		const app = createSystemBackupRoute({ service });

		const res = await post(app, "/import", { backup: envelope("sanitized"), mode: "overwrite" });

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			code: "invalid",
			message: "备份的「订阅」一节里混进了拓展订阅，整份没有恢复",
		});
	});

	it("export 时服务抛的 BackupRejectedError 也按自带码回", async () => {
		const service = fakeService({
			exportBackup: vi.fn(async () => {
				throw new BackupRejectedError("invalid", "完整备份必须设置 PIN");
			}),
		});
		const app = createSystemBackupRoute({ service });

		const res = await post(app, "/export", { kind: "sanitized" });

		expect(res.status).toBe(400);
		expect(((await res.json()) as ErrorBody).code).toBe("invalid");
	});

	it("恢复出来的配置没过校验(ConfigValidationError)→ 带上它的码与逐格原因,话里说清整份没有恢复", async () => {
		const service = fakeService({
			importBackup: vi.fn(async () => {
				throw ConfigValidationError.invalid(
					"targets",
					"推送目标挂着的连接不存在（connectionId=c9）",
					[{ path: ["connectionId"], message: "没有这条连接" }],
				);
			}),
		});
		const app = createSystemBackupRoute({ service });

		const res = await post(app, "/import", { backup: envelope("sanitized"), mode: "overwrite" });

		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorBody;
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("整份没有恢复");
		expect(body.message).toContain("推送目标挂着的连接不存在");
		expect(body.issues).toEqual([{ path: ["connectionId"], message: "没有这条连接" }]);
	});
});

describe("backup route — 未知的抛错是 bug,交给全局出错处理", () => {
	const DISK_ERROR = new Error("ENOSPC: no space left on device, write 'state/globals.json'");

	it("import 时磁盘写失败 → 503 unavailable + 固定一句话;原话进日志,不回给客户端", async () => {
		const service = fakeService({
			importBackup: vi.fn(async () => {
				throw DISK_ERROR;
			}),
		});
		const { app, logger } = mounted(service);

		const res = await post(app, "/api/system/backup/import", {
			backup: envelope("sanitized"),
			mode: "overwrite",
		});

		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ code: "unavailable", message: UNHANDLED_ERROR_MESSAGE });
		expect(logger.error).toHaveBeenCalledWith("unhandled request error", DISK_ERROR);
	});

	it("export 时抛的未知错也一样,不再变成 `export_failed` + `String(err)`", async () => {
		const service = fakeService({
			exportBackup: vi.fn(async () => {
				throw DISK_ERROR;
			}),
		});
		const { app, logger } = mounted(service);

		const res = await post(app, "/api/system/backup/export", { kind: "sanitized" });

		expect(res.status).toBe(503);
		const text = JSON.stringify(await res.json());
		expect(text).not.toContain("ENOSPC");
		expect(text).not.toContain("Error:");
		expect(logger.error).toHaveBeenCalledWith("unhandled request error", DISK_ERROR);
	});
});
