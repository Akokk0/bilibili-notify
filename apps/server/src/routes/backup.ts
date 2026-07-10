import { Hono } from "hono";
import { BackupPinError } from "../backup/crypto.js";
import { validateBackup } from "../backup/envelope.js";
import type { ImportMode } from "../backup/restore.js";
import type { BackupService, SectionSelection } from "../backup/service.js";

/**
 * `/api/backup` — export/import for the one-click backup feature. Mounted behind
 * the dashboard auth gate (like every `/api/*` route), so only an authenticated
 * dashboard session can download secrets or overwrite the running config.
 *
 * The route is a thin HTTP shell: parse/validate the request, delegate to the
 * injected {@link BackupService}, and map failures to 400. `validateBackup` is
 * the import trust boundary — a body that is not a recognizable backup never
 * reaches the service.
 */
export function createBackupRoute(opts: { service: BackupService }): Hono {
	const app = new Hono();

	app.post("/export", async (c) => {
		let body: { kind?: unknown; sections?: SectionSelection; pin?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid_json", message: "request body must be valid JSON" }, 400);
		}
		const kind = body.kind;
		if (kind !== "full" && kind !== "sanitized") {
			return c.json({ error: "invalid_kind", message: "kind must be 'full' or 'sanitized'" }, 400);
		}
		if (kind === "full" && !body.pin) {
			return c.json({ error: "pin_required", message: "a full backup requires a PIN" }, 400);
		}
		try {
			const env = await opts.service.exportBackup({
				kind,
				sections: body.sections,
				pin: body.pin,
			});
			return c.json(env);
		} catch (err) {
			return c.json({ error: "export_failed", message: String(err) }, 400);
		}
	});

	app.post("/import", async (c) => {
		let body: { backup?: unknown; pin?: string; mode?: unknown };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid_json", message: "request body must be valid JSON" }, 400);
		}
		const mode = body.mode;
		if (mode !== "overwrite" && mode !== "merge") {
			return c.json({ error: "invalid_mode", message: "mode must be 'overwrite' or 'merge'" }, 400);
		}
		let envelope: ReturnType<typeof validateBackup>;
		try {
			envelope = validateBackup(body.backup);
		} catch (err) {
			return c.json({ error: "invalid_backup", message: String(err) }, 400);
		}
		if (envelope.kind === "full" && !body.pin) {
			return c.json({ error: "pin_required", message: "a full backup requires a PIN" }, 400);
		}
		try {
			const result = await opts.service.importBackup({
				envelope,
				pin: body.pin,
				mode: mode as ImportMode,
			});
			return c.json(result);
		} catch (err) {
			if (err instanceof BackupPinError) {
				return c.json({ error: "wrong_pin", message: err.message }, 400);
			}
			return c.json({ error: "import_failed", message: String(err) }, 400);
		}
	});

	return app;
}
