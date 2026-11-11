import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { DevelopmentDirectoriesResponse } from "@bilibili-notify/contract";
import { fail, ok, type Result } from "@bilibili-notify/internal";

/** 仅供源码开发版目录选择器使用；读取失败按标准结果返回。 */
export async function browseDevelopmentDirectories(
	directory: string,
): Promise<Result<{ listing: DevelopmentDirectoriesResponse }>> {
	if (!isAbsolute(directory)) return fail("invalid", "请选择BN所在机器上的绝对目录路径");
	try {
		const current = await realpath(directory);
		const children = await readdir(current, { withFileTypes: true });
		const directories = await Promise.all(
			children.map(async (entry) => {
				if (entry.isDirectory()) return { name: entry.name, path: join(current, entry.name) };
				if (!entry.isSymbolicLink()) return undefined;
				const path = join(current, entry.name);
				const directory = await stat(path).then(
					(value) => value.isDirectory(),
					(error: NodeJS.ErrnoException) => {
						if (error.code === "ENOENT") return false;
						throw error;
					},
				);
				return directory ? { name: entry.name, path } : undefined;
			}),
		);
		const hasManifest = await stat(join(current, "extension.json")).then(
			(value) => value.isFile(),
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return false;
				throw error;
			},
		);
		return ok({
			listing: {
				directory: current,
				parent: dirname(current) === current ? null : dirname(current),
				hasManifest,
				entries: directories
					.filter((entry) => entry !== undefined)
					.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
			},
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return fail(
			code === "ENOENT" ? "not_found" : code === "ENOTDIR" ? "invalid" : "unavailable",
			`无法浏览目录：${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
