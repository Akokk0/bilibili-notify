import { type Failure, fail } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { validateBackup } from "../backup/envelope.js";
import { BACKUP_PIN_REQUIRED_MESSAGE, BackupRejectedError } from "../backup/rejected-error.js";
import type { ImportMode } from "../backup/restore.js";
import type { BackupService, SectionSelection } from "../backup/service.js";
import { ConfigValidationError } from "../config/validation-error.js";
import { readJsonObject } from "./request-body.js";
import { respondFailure } from "./respond-failure.js";

/**
 * `/api/backup` — export/import for the one-click backup feature. Mounted behind
 * the dashboard auth gate (like every `/api/*` route), so only an authenticated
 * dashboard session can download secrets or overwrite the running config.
 *
 * The route is a thin HTTP shell: parse/validate the request, delegate to the
 * injected {@link BackupService}, and answer failures in the standard shape
 * (ADR-0026). `validateBackup` is the import trust boundary — a body that is not
 * a recognizable backup never reaches the service.
 *
 * 失败怎么分(口径见 docs/agents/conventions/failure-results.md):
 * - **可预期的**,原因写进 `message`:请求体 / kind / mode / PIN 不对、文件不是备份、版本太新、
 *   恢复出来的配置没过校验 —— 这些从服务那头抛的是 {@link BackupRejectedError} 或 `ConfigValidationError`,
 *   自带码,路由不嗅文案。PIN 不对是 `invalid`,**不是** `unauthorized`(那会被面板当成看板登录失效)。
 * - **不可预期的**(磁盘写失败、密钥库出错……)是 bug 或环境的事,原样往外抛,交给全局出错处理:
 *   原话进日志,客户端只拿一句固定的话 —— `String(err)` 里可能带路径。
 */

/** 备份导入 / 导出里认得的拒收 → 失败;认不得的返回 null,调用方接着抛。 */
function failureOfBackupError(err: unknown): Failure | null {
	if (err instanceof BackupRejectedError) return err.toFailure();
	if (err instanceof ConfigValidationError) {
		// 恢复是「先全量校验再一次落地」,校验没过就什么都没写 —— 话里要说清这一点。
		const { code, message, issues } = err.toFailure();
		return fail(code, `备份里的配置没通过校验，整份没有恢复：${message}`, issues ? { issues } : {});
	}
	return null;
}

export function createBackupRoute(opts: { service: BackupService }): Hono {
	const app = new Hono();

	app.post("/export", async (c) => {
		const read = await readJsonObject(c);
		if (!read.ok) return respondFailure(c, read);
		const body = read.body as { kind?: unknown; sections?: SectionSelection; pin?: unknown };
		const kind = body.kind;
		if (kind !== "full" && kind !== "sanitized") {
			return respondFailure(c, fail("invalid", "kind 只能是 full 或 sanitized"));
		}
		const pin = typeof body.pin === "string" ? body.pin : undefined;
		if (kind === "full" && !pin)
			return respondFailure(c, fail("invalid", BACKUP_PIN_REQUIRED_MESSAGE));
		try {
			const env = await opts.service.exportBackup({ kind, sections: body.sections, pin });
			return c.json(env);
		} catch (err) {
			const failure = failureOfBackupError(err);
			if (failure) return respondFailure(c, failure);
			throw err;
		}
	});

	app.post("/import", async (c) => {
		const read = await readJsonObject(c);
		if (!read.ok) return respondFailure(c, read);
		const body = read.body as { backup?: unknown; pin?: unknown; mode?: unknown; dryRun?: unknown };
		const mode = body.mode;
		if (mode !== "overwrite" && mode !== "merge") {
			return respondFailure(c, fail("invalid", "mode 只能是 overwrite 或 merge"));
		}
		let envelope: ReturnType<typeof validateBackup>;
		try {
			envelope = validateBackup(body.backup);
		} catch (err) {
			const failure = failureOfBackupError(err);
			if (failure) return respondFailure(c, failure);
			throw err;
		}
		const pin = typeof body.pin === "string" ? body.pin : undefined;
		if (envelope.kind === "full" && !pin)
			return respondFailure(c, fail("invalid", BACKUP_PIN_REQUIRED_MESSAGE));
		try {
			const result = await opts.service.importBackup({
				envelope,
				pin,
				mode: mode as ImportMode,
				dryRun: body.dryRun === true,
			});
			return c.json(result);
		} catch (err) {
			const failure = failureOfBackupError(err);
			if (failure) return respondFailure(c, failure);
			throw err;
		}
	});

	return app;
}
