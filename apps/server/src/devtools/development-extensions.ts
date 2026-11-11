import { lstat, mkdir, readFile, readlink, realpath, rm, symlink } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { DevelopmentExtensionMountView } from "@bilibili-notify/contract";
import { EXTENSION_API_RANGE, fail, ok, type Result } from "@bilibili-notify/internal";
import type { DevelopmentExtensionEntry } from "../extensions/discover.js";
import { parseHostExtensionManifest } from "../extensions/identity.js";
import type { LoadedExtensions } from "../extensions/loader.js";
import { browseDevelopmentDirectories } from "./development-directories.js";
import { openDevelopmentSource } from "./development-source.js";

export interface DevelopmentExtensionsOptions {
	root: string;
	initialDirectory?: string;
	reservedIntegrationKeys: readonly string[];
	extensions: () => Pick<LoadedExtensions, "changeDisk" | "reload" | "rescan" | "list"> | undefined;
}
interface SourceMount {
	view: DevelopmentExtensionMountView;
	source: Awaited<ReturnType<typeof openDevelopmentSource>>;
	entry: DevelopmentExtensionEntry;
	closed: boolean;
	timer?: NodeJS.Timeout;
	work?: Promise<Result>;
	again: boolean;
}

/** 源码工程只经显式挂载进入唯一装载根，运行与收尾仍由原装载器负责。 */
export function createDevelopmentExtensions(options: DevelopmentExtensionsOptions) {
	const mounts = new Map<string, SourceMount>();
	const list = () => [...mounts.values()].map(({ view }) => ({ ...view }));
	const at = (id: string) => join(options.root, id);
	async function owned(mount: SourceMount) {
		return (await readlink(at(mount.view.id)).catch(() => undefined)) === mount.view.directory;
	}
	function schedule(mount: SourceMount) {
		if (mount.closed || !mount.view.watching) return;
		if (mount.work) {
			mount.again = true;
			return;
		}
		if (mount.timer) clearTimeout(mount.timer);
		mount.timer = setTimeout(() => {
			void refresh(mount);
		}, 100);
	}
	async function refresh(mount: SourceMount) {
		if (mount.closed) return fail("not_found", "开发挂载已解除");
		if (mount.work) return mount.work;
		const work = async () => {
			const loaded = options.extensions();
			if (!loaded) return fail("unavailable", "拓展装载器尚未就绪");
			if (!(await owned(mount))) {
				mount.view.error = "挂载目录已被更改，不能加载其他工程";
				return fail("conflict", mount.view.error);
			}
			const read = await mount.source.read();
			if (!read.ok) {
				mount.view.error = read.message;
				return read;
			}
			if (read.entry.manifest.id !== mount.view.id) {
				mount.view.error = "源码工程ID已经更改，请解除后重新挂载";
				return fail("conflict", mount.view.error);
			}
			if (mount.closed) return fail("not_found", "开发挂载已解除");
			mount.entry = read.entry;
			try {
				if (loaded.list().find((entry) => entry.id === mount.view.id)?.state === "disabled")
					await loaded.rescan();
				else await loaded.reload(mount.view.id);
				mount.view.reloads += 1;
				mount.view.error = undefined;
				return ok();
			} catch (error) {
				mount.view.error = error instanceof Error ? error.message : String(error);
				return fail("unavailable", mount.view.error);
			}
		};
		mount.work = work();
		try {
			return await mount.work;
		} finally {
			mount.work = undefined;
			if (mount.again) {
				mount.again = false;
				schedule(mount);
			}
		}
	}
	async function mount(directory: string, shouldWatch: boolean) {
		if (!isAbsolute(directory)) return fail("invalid", "请填写BN所在机器上的工程绝对路径");
		const loaded = options.extensions();
		if (!loaded) return fail("unavailable", "拓展装载器尚未就绪");
		let project: string;
		let id: string;
		try {
			project = await realpath(directory);
			const raw: unknown = JSON.parse(await readFile(join(project, "extension.json"), "utf8"));
			const checked = parseHostExtensionManifest(
				raw,
				EXTENSION_API_RANGE,
				options.reservedIntegrationKeys,
			);
			if (!checked.ok) return fail("invalid", "工程清单无效或与宿主契约不兼容");
			id = checked.manifest.id;
		} catch {
			return fail("invalid", "工程目录或extension.json读不了");
		}
		if (await lstat(at(id)).catch(() => undefined))
			return fail("conflict", "这个拓展ID已经被安装或挂载，不能覆盖");
		let mounted: SourceMount | undefined;
		const source = await openDevelopmentSource(project, options.reservedIntegrationKeys, () => {
			if (mounted) schedule(mounted);
		});
		const read = await source.read();
		if (!read.ok) {
			await source.dispose();
			return read;
		}
		if (read.entry.manifest.id !== id) {
			await source.dispose();
			return fail("conflict", "源码工程ID在加载期间改变，请重新挂载");
		}
		mounted = {
			view: { id, directory: project, entry: read.entry.entry, watching: shouldWatch, reloads: 0 },
			source,
			entry: read.entry,
			closed: false,
			again: false,
		};
		const prepared = mounted;
		let changed: Result;
		try {
			changed = await loaded.changeDisk(async () => {
				if (await lstat(at(id)).catch(() => undefined))
					return fail("conflict", "这个拓展ID已经被安装或挂载，不能覆盖");
				await mkdir(options.root, { recursive: true });
				await symlink(project, at(id), platform() === "win32" ? "junction" : "dir");
				mounts.set(id, prepared);
				return ok();
			});
		} catch (error) {
			prepared.closed = true;
			await source.dispose();
			return fail("unavailable", error instanceof Error ? error.message : String(error));
		}
		if (!changed.ok) {
			prepared.closed = true;
			await source.dispose();
			return changed;
		}
		return ok({ id, mounts: list() });
	}
	async function unmount(id: string) {
		const mounted = mounts.get(id);
		if (!mounted) return fail("not_found", "没有这项开发挂载");
		const loaded = options.extensions();
		if (!loaded) return fail("unavailable", "拓展装载器尚未就绪");
		if (!(await owned(mounted))) return fail("conflict", "挂载目录已被更改，不能移除其他文件");
		mounted.closed = true;
		if (mounted.timer) clearTimeout(mounted.timer);
		await mounted.work;
		const result = await loaded.changeDisk(async () => {
			if (!(await owned(mounted))) return fail("conflict", "挂载目录已被更改，不能移除其他文件");
			await rm(at(id));
			mounts.delete(id);
			return ok();
		});
		if (!result.ok) {
			mounted.closed = false;
			return result;
		}
		await mounted.source.dispose();
		return ok({ mounts: list() });
	}
	return {
		directories: (directory = options.initialDirectory ?? dirname(options.root)) =>
			browseDevelopmentDirectories(directory),
		list,
		mount,
		unmount,
		async resolveEntry(directory: string) {
			const mounted = mounts.get(basename(directory));
			return mounted &&
				resolve(directory) === resolve(at(mounted.view.id)) &&
				(await owned(mounted))
				? mounted.entry
				: undefined;
		},
		devtoolsEntry(directory: string) {
			const mounted = mounts.get(basename(directory));
			return mounted && resolve(directory) === resolve(at(mounted.view.id))
				? {
						file: join(mounted.view.directory, "src/devtools/index.ts"),
						load: mounted.source.devtools,
					}
				: undefined;
		},
		async reload(id: string) {
			const mounted = mounts.get(id);
			return mounted ? refresh(mounted) : fail("not_found", "没有这项开发挂载");
		},
		setWatching(id: string, enabled: boolean) {
			const mounted = mounts.get(id);
			if (!mounted) return fail("not_found", "没有这项开发挂载");
			mounted.view.watching = enabled;
			if (enabled) schedule(mounted);
			else if (mounted.timer) clearTimeout(mounted.timer);
			return ok();
		},
		async dispose() {
			for (const id of [...mounts.keys()]) {
				const removed = await unmount(id);
				if (!removed.ok) {
					const mounted = mounts.get(id);
					if (mounted) {
						mounted.closed = true;
						if (mounted.timer) clearTimeout(mounted.timer);
						await mounted.work;
						await mounted.source.dispose();
					}
				}
			}
			mounts.clear();
		},
	};
}
export type DevelopmentExtensions = ReturnType<typeof createDevelopmentExtensions>;
