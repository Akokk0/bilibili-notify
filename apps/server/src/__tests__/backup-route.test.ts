import { describe, expect, it, vi } from "vite-plus/test";
import { BackupPinError } from "../backup/crypto.js";
import { BACKUP_FORMAT, BACKUP_SCHEMA_VERSION, type BackupEnvelope } from "../backup/envelope.js";
import type { BackupService } from "../backup/service.js";
import { createBackupRoute } from "../routes/backup.js";

/**
 * /api/backup 路由只负责 HTTP 层:解析/校验请求、把已验的信封交给 service、映射错误码。
 * 备份业务逻辑由 service 测试覆盖,这里注入 fake service 只验接线与状态码。
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
		exportBackup: vi.fn(async () => envelope("sanitized")),
		importBackup: vi.fn(async () => ({
			subscriptions: { upserted: 1, deleted: 0 },
			adapters: { upserted: 0, deleted: 0 },
			targets: { upserted: 0, deleted: 0 },
			globalsApplied: false,
			cookiesRestored: false,
		})),
		...over,
	};
}

function post(app: ReturnType<typeof createBackupRoute>, path: string, body: unknown) {
	return app.request(path, {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
	});
}

describe("backup route", () => {
	it("POST /export returns the envelope from the service", async () => {
		const service = fakeService();
		const app = createBackupRoute({ service });

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
		const app = createBackupRoute({ service });

		const res = await post(app, "/export", { kind: "full" });

		expect(res.status).toBe(400);
		expect(service.exportBackup).not.toHaveBeenCalled();
	});

	it("POST /import validates the document and applies it", async () => {
		const service = fakeService();
		const app = createBackupRoute({ service });

		const res = await post(app, "/import", { backup: envelope("sanitized"), mode: "merge" });

		expect(res.status).toBe(200);
		expect(service.importBackup).toHaveBeenCalledWith(expect.objectContaining({ mode: "merge" }));
	});

	it("POST /import forwards dryRun so the dashboard can preview the plan", async () => {
		const service = fakeService();
		const app = createBackupRoute({ service });

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
		const app = createBackupRoute({ service });

		const res = await post(app, "/import", { backup: { hello: "x" }, mode: "overwrite" });

		expect(res.status).toBe(400);
		expect(service.importBackup).not.toHaveBeenCalled();
	});

	it("POST /import maps a wrong-PIN error to 400", async () => {
		const service = fakeService({
			importBackup: vi.fn(async () => {
				throw new BackupPinError();
			}),
		});
		const app = createBackupRoute({ service });

		const res = await post(app, "/import", {
			backup: envelope("full"),
			pin: "0000",
			mode: "overwrite",
		});

		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("wrong_pin");
	});
});
