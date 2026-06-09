import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Files whose presence proves a directory is a bilibili-notify AstrBot plugin
// install (or a freshly-checked-out source tree). We only ever destructively
// overwrite a target that looks like one of ours.
const PLUGIN_MARKERS = ["metadata.yaml", "main.py"];

// Target-side runtime state produced by a running plugin instance. These hold
// B站 cookies, subscription persistence and rolling logs — they must survive a
// sync/link overwrite, so we never delete them when wiping stale plugin files.
const PRESERVED_RUNTIME = [
	["sidecar", "state"],
	["sidecar", "cache"],
	["sidecar", "logs"],
];

async function statOrNull(path) {
	try {
		return await lstat(path);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

export async function exists(path) {
	return (await statOrNull(path)) !== null;
}

async function isNonEmptyDir(path) {
	const stats = await statOrNull(path);
	if (!stats?.isDirectory()) return false;
	const entries = await readdir(path);
	return entries.length > 0;
}

async function hasPluginMarker(path) {
	for (const marker of PLUGIN_MARKERS) {
		if (await exists(join(path, marker))) return true;
	}
	return false;
}

/**
 * Guard a destructive overwrite of an AstrBot plugin target.
 *
 * Refuses (throws) when the target is a non-empty directory that does NOT look
 * like a bilibili-notify AstrBot plugin (no marker file). An empty directory,
 * a missing path, or a marked plugin directory are all accepted — those are the
 * legitimate fresh-install / re-sync cases.
 */
export async function assertSafeTarget(targetDir) {
	if (!(await isNonEmptyDir(targetDir))) return; // missing, empty, or not a dir → fresh install
	if (await hasPluginMarker(targetDir)) return; // an existing bilibili-notify plugin → ok to overwrite
	throw new Error(
		`拒绝删除: ${targetDir} 非空且不是 bilibili-notify AstrBot 插件目录` +
			`（缺少标识文件 ${PLUGIN_MARKERS.join(" / ")}）。` +
			`请确认目标路径，避免误删无关文件。`,
	);
}

/**
 * Remove stale plugin files from an existing target while preserving the
 * running instance's runtime state (sidecar/state, sidecar/cache, sidecar/logs).
 *
 * Deletes every top-level entry except the preserved runtime roots, then prunes
 * stale children inside the preserved roots' parents without touching the
 * runtime directories themselves. For a missing target this is a no-op.
 */
export async function clearTargetPreservingRuntime(targetDir) {
	const rootStats = await statOrNull(targetDir);
	if (!rootStats) return;
	if (!rootStats.isDirectory()) {
		// A symlink or stray file at the target path — nothing to preserve, drop it.
		await rm(targetDir, { recursive: true, force: true });
		return;
	}

	const preservedTop = new Set(PRESERVED_RUNTIME.map((segments) => segments[0]));
	const preservedFull = new Set(PRESERVED_RUNTIME.map((segments) => segments.join("/")));

	const topEntries = await readdir(targetDir);
	for (const entry of topEntries) {
		if (!preservedTop.has(entry)) {
			await rm(join(targetDir, entry), { recursive: true, force: true });
		}
	}

	// For each preserved top-level dir (e.g. "sidecar"), delete stale siblings of
	// the preserved children but keep the runtime children themselves.
	for (const top of preservedTop) {
		const topPath = join(targetDir, top);
		const topStats = await statOrNull(topPath);
		if (!topStats) continue; // no such preserved root in this target
		if (!topStats.isDirectory()) {
			// e.g. a stale "sidecar" file rather than a dir — drop it.
			await rm(topPath, { recursive: true, force: true });
			continue;
		}
		const children = await readdir(topPath);
		for (const child of children) {
			if (!preservedFull.has(`${top}/${child}`)) {
				await rm(join(topPath, child), { recursive: true, force: true });
			}
		}
	}
}

export { PLUGIN_MARKERS, PRESERVED_RUNTIME };
