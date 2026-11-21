import { lstat, mkdir, readFile, readlink, realpath, rm, symlink } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { DevelopmentExtensionMountView } from "@bilibili-notify/contract";
import { EXTENSION_API_RANGE, fail, ok, type Result } from "@bilibili-notify/internal";
import { atomicWriteJson } from "@bilibili-notify/storage";
import { z } from "zod";
import {
	type DevelopmentEntryResolver,
	type DevelopmentExtensionEntry,
	EXTENSION_ENTRY_FILE,
} from "../extensions/discover.js";
import { extensionIdSchema, parseHostExtensionManifest } from "../extensions/identity.js";
import type { LoadedExtensions } from "../extensions/loader.js";
import { browseDevelopmentDirectories } from "./development-directories.js";
import { developmentManifestFailure, openDevelopmentSource } from "./development-source.js";

export interface DevelopmentExtensionsOptions {
	root: string;
	initialDirectory?: string;
	reservedIntegrationKeys: readonly string[];
	extensions: () => Pick<LoadedExtensions, "changeDisk" | "reload" | "rescan" | "list"> | undefined;
}
const mountRecord = z.object({ directory: z.string().refine(isAbsolute), watching: z.boolean() });
type MountRecord = z.infer<typeof mountRecord>;
type Source = Awaited<ReturnType<typeof openDevelopmentSource>>;

interface SourceMount {
	view: DevelopmentExtensionMountView;
	source: Source;
	entry: Result<{ entry: DevelopmentExtensionEntry }>;
	closed: boolean;
	timer?: NodeJS.Timeout;
	work?: Promise<Result>;
	again: boolean;
}

/** 源码工程只经显式挂载进入唯一装载根，运行与收尾仍由原装载器负责。 */
export function createDevelopmentExtensions(options: DevelopmentExtensionsOptions) {
	const mounts = new Map<string, SourceMount>();
	let disposed = false;
	const list = () => [...mounts.values()].map(({ view }) => ({ ...view }));
	const at = (id: string) => join(options.root, id);
	const recordPath = (id: string) => join(options.root, `.${id}.development.json`);
	const linkTarget = (id: string) => readlink(at(id)).catch(() => undefined);
	async function owned(mount: SourceMount) {
		return (await linkTarget(mount.view.id)) === mount.view.directory;
	}
	async function prepare(id: string, { directory, watching }: MountRecord): Promise<SourceMount> {
		let mounted: SourceMount | undefined;
		const source = await openDevelopmentSource(directory, options.reservedIntegrationKeys, () => {
			if (mounted) schedule(mounted);
		});
		const read = await source.read();
		const entry =
			read.ok && read.entry.manifest.id !== id
				? fail("conflict", "源码工程ID在加载期间改变，请重新挂载")
				: read;
		mounted = {
			view: {
				id,
				directory,
				entry: join(directory, "src/index.ts"),
				watching,
				reloads: 0,
				...(!entry.ok && { error: entry.message }),
			},
			source,
			entry,
			closed: false,
			again: false,
		};
		return mounted;
	}
	async function restore(id: string) {
		const persisted = await readFile(recordPath(id), "utf8")
			.then((text) => mountRecord.safeParse(JSON.parse(text)))
			.catch(() => undefined);
		if (!persisted?.success || (await linkTarget(id)) !== persisted.data.directory) return;
		if ((await realpath(at(id)).catch(() => undefined)) !== persisted.data.directory) return;
		const mounted = await prepare(id, persisted.data);
		if (disposed || !(await owned(mounted))) {
			await mounted.source.dispose();
			return;
		}
		mounts.set(id, mounted);
		return mounted;
	}
	async function occupied(id: string, project: string) {
		if (mounts.has(id)) return true;
		if (!(await lstat(at(id)).catch(() => undefined))) return false;
		// 旧版只留下链接。只有主人再次选择该源码工程时才接管它。
		return (
			(await linkTarget(id)) !== project ||
			Boolean(await lstat(join(at(id), EXTENSION_ENTRY_FILE)).catch(() => undefined))
		);
	}
	async function removeLink(id: string) {
		await rm(at(id));
		// 没有匹配的链接时，残留的记录不会恢复工程。
		await rm(recordPath(id), { force: true }).catch(() => {});
	}
	function schedule(mount: SourceMount) {
		if (mount.closed || !mount.view.watching || mounts.get(mount.view.id) !== mount) return;
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
			const needsRescan = !mount.entry.ok;
			mount.entry = read;
			try {
				if (
					needsRescan ||
					loaded.list().find((entry) => entry.id === mount.view.id)?.state === "disabled"
				)
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
		if (!loaded || disposed) return fail("unavailable", "拓展装载器尚未就绪");
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
			if (!checked.ok) return developmentManifestFailure(checked);
			id = checked.manifest.id;
		} catch {
			return fail("invalid", "工程目录或extension.json读不了");
		}
		if (await occupied(id, project))
			return fail("conflict", "这个拓展ID已经被安装或挂载，不能覆盖");
		const record = { directory: project, watching: shouldWatch };
		const prepared = await prepare(id, record);
		if (!prepared.entry.ok) {
			await prepared.source.dispose();
			return prepared.entry;
		}
		let changed: Result;
		try {
			changed = await loaded.changeDisk(async () => {
				if (disposed) return fail("unavailable", "拓展装载器尚未就绪");
				if (await occupied(id, project))
					return fail("conflict", "这个拓展ID已经被安装或挂载，不能覆盖");
				await mkdir(options.root, { recursive: true });
				const existing = (await linkTarget(id)) === project;
				if (!existing) await symlink(project, at(id), platform() === "win32" ? "junction" : "dir");
				try {
					await atomicWriteJson(recordPath(id), record);
				} catch (error) {
					if (!existing && (await owned(prepared))) await removeLink(id);
					throw error;
				}
				if (disposed) return fail("unavailable", "拓展装载器尚未就绪");
				mounts.set(id, prepared);
				return ok();
			});
		} catch (error) {
			if (mounts.get(id) !== prepared && !prepared.closed) {
				prepared.closed = true;
				await prepared.source.dispose();
			}
			return fail("unavailable", error instanceof Error ? error.message : String(error));
		}
		if (!changed.ok) {
			prepared.closed = true;
			await prepared.source.dispose();
			return changed;
		}
		return ok({ id, mounts: list() });
	}
	async function unmount(id: string) {
		const mounted = mounts.get(id);
		if (!mounted) {
			// 旧版构建产物或未重新挂载的源码链接没有当前进程的监听句柄。
			// 仍只移除装载根中的链接，保留指向的工程以及配置、状态和密钥。
			if (!extensionIdSchema(options.reservedIntegrationKeys).safeParse(id).success)
				return fail("invalid", "拓展ID无效");
			const loaded = options.extensions();
			if (!loaded) return fail("unavailable", "拓展装载器尚未就绪");
			const target = await linkTarget(id);
			if (target === undefined) return fail("not_found", "没有这项开发挂载");
			const result = await loaded.changeDisk(async () => {
				if ((await linkTarget(id)) !== target)
					return fail("conflict", "挂载目录已被更改，不能移除其他文件");
				// 非递归：即使路径被换成真实目录，也不会沿目录清理。
				await removeLink(id);
				return ok();
			});
			return result.ok ? ok({ mounts: list() }) : result;
		}
		const loaded = options.extensions();
		if (!loaded) return fail("unavailable", "拓展装载器尚未就绪");
		if (!(await owned(mounted))) return fail("conflict", "挂载目录已被更改，不能移除其他文件");
		mounted.closed = true;
		if (mounted.timer) clearTimeout(mounted.timer);
		await mounted.work;
		const result = await loaded.changeDisk(async () => {
			if (!(await owned(mounted))) return fail("conflict", "挂载目录已被更改，不能移除其他文件");
			await removeLink(id);
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
	const resolveEntry: DevelopmentEntryResolver = async (directory) => {
		const id = basename(directory);
		if (disposed || resolve(directory) !== resolve(at(id))) return;
		try {
			const mounted = mounts.get(id) ?? (await restore(id));
			if (!mounted || !(await owned(mounted))) return;
			return mounted.entry.ok ? mounted.entry.entry : { error: mounted.entry.message };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	};
	return {
		directories: (directory = options.initialDirectory ?? dirname(options.root)) =>
			browseDevelopmentDirectories(directory),
		list,
		mount,
		unmount,
		resolveEntry,
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
			disposed = true;
			const active = [...mounts.values()];
			mounts.clear();
			for (const mounted of active) {
				mounted.closed = true;
				if (mounted.timer) clearTimeout(mounted.timer);
			}
			await Promise.all(
				active.map(async (mounted) => {
					await mounted.work;
					await mounted.source.dispose();
				}),
			);
		},
	};
}
export type DevelopmentExtensions = ReturnType<typeof createDevelopmentExtensions>;
