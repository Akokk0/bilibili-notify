/**
 * 资产存储:一个目录里放一类文件,资产 id 就是文件名。
 *
 * 三个各写各的存储(卡片背景图、聊天附件、字体)收成这一份 —— 它们干的是同一件事:认后缀、
 * 限大小、取名、落盘、按 id 读回、列出来、删掉。差别只有四处,全部做成参数:目录、认得的格式、
 * 大小上限、id 怎么取。
 *
 * **id 是唯一的防穿越闸门。** id 会从 HTTP 请求原样进来,而数据目录里躺着带凭据的文件。
 * {@link AssetStore.isValidId} 是所有读、删、取路径的入口:不合法的 id 不碰盘。
 *
 * **目录才是真相。** 可选的原名清单(`labelsFile`)只贡献「显示名」:清单丢了照样列得出资产,
 * 清单里多出盘上没有的记录一概不列。
 */

import { randomBytes } from "node:crypto";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createSerialQueue } from "@bilibili-notify/internal";
import {
	atomicWriteFile,
	atomicWriteJson,
	isLeftoverName,
	readJsonFile,
} from "@bilibili-notify/storage";
import { parseAssetNames, sanitizeAssetLabel } from "../runtime/asset-labels.js";

export interface AssetStoreOptions {
	/** 资产目录的绝对路径。不必事先存在,第一次写入时建。 */
	dir: string;
	/** 认得的后缀 → mime。只有这些后缀能存、能读。 */
	formats: Readonly<Record<string, string>>;
	/** 单件字节上限;要按后缀分线就给函数。 */
	maxBytes: number | ((ext: string) => number);
	/**
	 * id 怎么取。`random`:存储自己起 `<32 位小写 hex>.<后缀>`,同一份字节存两次也是两个 id。
	 * `given`:id 就是调用方给的名字,同名直接覆盖;名字合不合规矩由 `isValidName` 判,
	 * 路径成分(`/`、`\`、`.`、`..`)不论它怎么说都一律拒。
	 */
	naming: { kind: "random" } | { kind: "given"; isValidName(name: string): boolean };
	/** 原名清单的文件名(住在 `dir` 里)。不给就不记原名。 */
	labelsFile?: string;
}

export interface AssetPutOptions {
	bytes: Uint8Array;
	/** 后缀(不带点),得是 `formats` 里的键。`given` 取名时,名字的后缀必须与它一致。 */
	ext: string;
	/** `given` 取名时必填:资产的名字,也就是它的 id。 */
	name?: string;
	/** 上传时的原始文件名,记进原名清单供显示;没给 `labelsFile` 时忽略。 */
	label?: string;
}

/** 存一件资产的结果:成功给 id,可预期的拒收回 `invalid`。磁盘写失败是抛错。 */
export type AssetPutResult =
	| { ok: true; id: string }
	| { ok: false; code: "invalid"; message: string };

/** 列表里的一件资产。 */
export interface AssetView {
	id: string;
	/** 文件字节数;读不到(刚被删)记 0,不影响列出。 */
	size: number;
	/** 原名清单里记的显示名;没记(或清单丢了)就没有这个字段。 */
	label?: string;
}

export interface AssetStore {
	/** id 合不合法:`random` 是 32 位 hex + 认得的后缀,`given` 是 `isValidName` 且后缀认得。 */
	isValidId(id: string): boolean;
	put(options: AssetPutOptions): Promise<AssetPutResult>;
	/** 读字节与 mime;id 不合法或文件不在回 null。 */
	read(id: string): Promise<{ bytes: Buffer; mime: string } | null>;
	/** 资产在盘上的路径;id 不合法回 null。**不**查文件在不在。 */
	pathOf(id: string): string | null;
	list(): Promise<AssetView[]>;
	/** 删一件并抹掉清单里那条;id 不合法或文件不在回 false。 */
	remove(id: string): Promise<boolean>;
	/** 原名清单(id → 显示名);没给 `labelsFile`、清单缺失或损坏都回空表。 */
	labels(): Promise<Record<string, string>>;
}

/** 随机取名的主名:32 位小写 hex。 */
const HEX32_STEM = /^[a-f0-9]{32}$/;

/**
 * 原名清单的写道。**模块级、键 = 清单文件的绝对路径**:清单是整份读、整份写,两个并发的
 * put 各读到同一份旧清单、各写回自己那一条,后写的盖掉先写的,所以同一份清单的每次读改写
 * 都得排进同一条队。队列不能住在 store 实例里 —— 调用方按数据目录就地建 store 时,
 * 同一个目录上必然有不止一个实例,各排各的队等于没排。资产字节的写不排,各写各的文件、
 * 原子改名,互不相干。
 *
 * 关停时只 flush 它({@link flushAssetLabelWrites}),**不关门**:队列是模块级的,同一个进程里下一个起的
 * 服务还要往同一条队写,关了它们就写不进了。
 */
const labelsQueue = createSerialQueue();

/** 等到所有资产库已经交进来的原名清单写全部落盘(成功失败都算)。只 flush、不关门,理由见 {@link labelsQueue}。 */
export function flushAssetLabelWrites(): Promise<void> {
	return labelsQueue.flush();
}

const isKnownExt = (formats: Readonly<Record<string, string>>, ext: string): boolean =>
	Object.hasOwn(formats, ext);

/** 名字里最后一个点之后的部分;没有点、或点在开头(没有主名)回空串。 */
function extOfName(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1) : "";
}

/** 文件字节数;读不到(刚被删 / 权限)记 0 —— 少一个数好过整个列表列不出来。 */
async function sizeOf(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

function invalid(message: string): AssetPutResult {
	return { ok: false, code: "invalid", message };
}

/**
 * id 合不合法,不用建 store、不用给目录:`random` 是 32 位小写 hex + 认得的后缀,`given` 是
 * `isValidName` 且后缀认得。暂存 / 旧目录残留的名字(`isLeftoverName`)与路径成分一律不合法。
 * {@link AssetStore.isValidId} 委托给它;只需要判 id、手边没有目录的地方(路由的参数校验)直接调它。
 */
export function isValidAssetId(
	options: Pick<AssetStoreOptions, "formats" | "naming">,
	id: string,
): boolean {
	const { formats, naming } = options;
	if (isLeftoverName(id)) return false;
	if (naming.kind === "random") {
		return HEX32_STEM.test(id.slice(0, 32)) && id[32] === "." && isKnownExt(formats, id.slice(33));
	}
	if (id === "." || id === ".." || /[/\\]/.test(id) || id.includes("\0")) return false;
	return isKnownExt(formats, extOfName(id)) && naming.isValidName(id);
}

export function createAssetStore(options: AssetStoreOptions): AssetStore {
	const { dir, formats, naming } = options;
	const labelsPath = options.labelsFile === undefined ? null : join(dir, options.labelsFile);

	// 存储层自己的清单文件不是资产:不能被当成资产读走、盖掉。
	const isValidId = (id: string): boolean =>
		id !== options.labelsFile && isValidAssetId(options, id);

	/**
	 * 读原名清单;缺失 / 损坏 / 读不动一律当空 —— 名字没了不该让整个图廊瘫掉。
	 * 内容过 {@link parseAssetNames}:键得是合法 id、值得洗得出一个能显示的标签,不合格的只丢那一条。
	 */
	const readLabels = async (): Promise<Record<string, string>> => {
		if (labelsPath === null) return {};
		try {
			const read = await readJsonFile(labelsPath);
			return read.kind === "ok" ? parseAssetNames(read.value, isValidId) : {};
		} catch {
			return {};
		}
	};

	/**
	 * 改一次原名清单:整份读进来交给 `edit` 改,改了(返回 true)才写回。读改写整个排进写道。
	 * 没给 `labelsFile` 时什么都不做。
	 */
	const editLabels = async (edit: (labels: Record<string, string>) => boolean): Promise<void> => {
		if (labelsPath === null) return;
		await labelsQueue.run(resolve(labelsPath), async () => {
			const labels = await readLabels();
			if (edit(labels)) await atomicWriteJson(labelsPath, labels);
		});
	};

	const store: AssetStore = {
		isValidId,

		async put({ bytes, ext, name, label }) {
			if (!isKnownExt(formats, ext)) {
				return invalid(`不支持的格式：${ext}（仅 ${Object.keys(formats).join(" / ")}）`);
			}
			const limit =
				typeof options.maxBytes === "function" ? options.maxBytes(ext) : options.maxBytes;
			if (bytes.byteLength > limit) return invalid(`文件过大（上限 ${limit} 字节）`);
			let id: string;
			if (naming.kind === "given") {
				if (name === undefined) return invalid("缺少资产名字");
				if (!isValidId(name)) return invalid(`资产名字不合法：${name}`);
				if (extOfName(name) !== ext) return invalid(`资产名字 ${name} 的后缀与 ${ext} 对不上`);
				id = name;
			} else {
				id = `${randomBytes(16).toString("hex")}.${ext}`;
			}
			await atomicWriteFile(join(dir, id), bytes);
			// 存进去的就先洗一遍(读出来那头也洗):浏览器给的这一串可能是整条桌面路径,
			// 也可能带着双向覆盖符 —— 让它显示成别的文件名,就把这个功能反过来用了。
			const clean = sanitizeAssetLabel(label);
			await editLabels((labels) => {
				if (clean !== null) {
					labels[id] = clean;
					return true;
				}
				// 没有新名字:同名覆盖时清单里可能还留着上一份内容的旧名,和新内容对不上,抹掉。
				if (!Object.hasOwn(labels, id)) return false;
				delete labels[id];
				return true;
			});
			return { ok: true, id };
		},

		async read(id) {
			if (!isValidId(id)) return null;
			try {
				const bytes = await readFile(join(dir, id));
				return { bytes, mime: formats[extOfName(id)] as string };
			} catch {
				return null;
			}
		},

		pathOf: (id) => (isValidId(id) ? join(dir, id) : null),

		async list() {
			let names: string[];
			try {
				names = await readdir(dir);
			} catch {
				return [];
			}
			const labels = await readLabels();
			return await Promise.all(
				names.filter(isValidId).map(async (id): Promise<AssetView> => {
					const label = labels[id];
					return {
						id,
						size: await sizeOf(join(dir, id)),
						...(label === undefined ? {} : { label }),
					};
				}),
			);
		},

		async remove(id) {
			if (!isValidId(id)) return false;
			try {
				await unlink(join(dir, id));
			} catch {
				return false;
			}
			await editLabels((labels) => {
				if (!Object.hasOwn(labels, id)) return false;
				delete labels[id];
				return true;
			});
			return true;
		},

		labels: readLabels,
	};
	return store;
}
