import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

/**
 * 首启动时被 `BN_WEB_DIST` seed 进 yaml 的那个值。
 *
 * **它从来不是用户的决定** —— `webDistDir` 在 dashboard 界面上根本没有入口
 * (`apps/web` / `apps/contract` 里一次都没出现),没人会去填它。所以看到这个值
 * 一律理解成「跟着载荷走」,而不是字面的 `/app/web-dist`。
 *
 * 正常路径下它会被一次性迁移从 yaml 里删掉;这里的判断是兜底 —— `/config` 只读
 * 挂载时迁移写不进去,那条路上也不能让用户坏掉。跑镜像自带那份载荷时,两种理解
 * 算出来是同一个目录,所以对现有部署**行为完全不变**。
 */
export const LEGACY_IMAGE_WEB_DIST = "/app/web-dist";

export interface ResolveWebDistDirInput {
	/** bootstrap yaml 里的 `webDistDir`。 */
	configured: string | undefined;
	/** `BN_WEB_DIST`。 */
	envValue: string | undefined;
	/** 当前这份载荷的入口(`import.meta.url`)。 */
	bundleUrl: string;
}

export interface ResolvedWebDistDir {
	dir: string;
	/**
	 * 这个目录是**用户点名的**还是**跟着载荷算出来的**。
	 *
	 * 决定了诊断怎么说:点名的目录要提醒「钉死了就不会跟着在线升级走」;算出来的那个
	 * 若连 `index.html` 都没有,说的是「这份载荷不完整」—— 反过来把用户自己指的空目录
	 * 赖到载荷头上,只会把人带沟里。
	 */
	source: "explicit" | "payload";
}

/**
 * dashboard 静态资源目录。
 *
 * 规矩:**属于载荷的东西相对 `index.mjs` 解析,属于用户的东西用固定绝对路径。**
 * web-dist 和服务端代码是同一次发布的两半,必须跟着当前跑的那份载荷走 —— 否则
 * 在线升级之后会变成「新服务端配旧前端」,而且不报错,直到某个改过的接口对不上
 * 才炸(当年 AstrBot 插件的 core/dashboard 错配就是这个形态)。
 *
 * 反过来 `/data`、`/config` 必须固定 —— 用户数据绝不能跟着代码版本走。
 *
 * {@link LEGACY_IMAGE_WEB_DIST} 是唯一的例外:它不是字面路径,而是「跟着载荷」的
 * 意思。详见该常量的说明。
 */
export function resolveWebDistDir({
	configured,
	envValue,
	bundleUrl,
}: ResolveWebDistDirInput): ResolvedWebDistDir {
	const explicit = pickExplicit(configured) ?? pickExplicit(envValue);
	if (explicit) return { dir: explicit, source: "explicit" };
	return { dir: join(dirname(fileURLToPath(bundleUrl)), "web-dist"), source: "payload" };
}

function pickExplicit(value: string | undefined): string | undefined {
	if (!value || value === LEGACY_IMAGE_WEB_DIST) return undefined;
	return value;
}

export interface DropLegacyWebDistDirResult {
	text: string;
	/** 真的改了才需要落盘 —— 没改就别去碰用户的文件。 */
	changed: boolean;
}

/**
 * 把 yaml 里那行机器种的 `webDistDir: /app/web-dist` 删掉。
 *
 * 删掉而不是留着当哨兵,是为了让 **yaml 上写的每一行都真的算数** —— 留一行「写着
 * 却不按字面生效」的配置,谁看到都会以为它在起作用,那是个新的困惑源。
 *
 * 走**文档级编辑**(`parseDocument` → `delete` → `toString`)而不是整份重新序列化:
 * 这份文件在用户手上、他可能编辑过,`stringifyYaml(config)` 会把他的注释和排版
 * 全部洗掉。文档级编辑只动该动的那一行,连被删键自己的说明注释也一并带走。
 *
 * 用户自己填的其他值一律不碰 —— 我们收回的只是**我们自己写进去的那句话**。
 */
export function dropLegacyWebDistDir(yamlText: string): DropLegacyWebDistDirResult {
	// 这是一次性迁移:第一次启动之后每一次开机都只会走到这一句。廉价地先看一眼字符串,
	// 稳态就不必再付一次**文档级** yaml 解析(`parseDocument` 连注释和排版一起建树,
	// 比 `parse` 重得多)。
	if (!yamlText.includes(LEGACY_IMAGE_WEB_DIST)) return { text: yamlText, changed: false };

	const doc = parseDocument(yamlText);
	if (doc.get("webDistDir") !== LEGACY_IMAGE_WEB_DIST) return { text: yamlText, changed: false };

	doc.delete("webDistDir");
	return { text: doc.toString(), changed: true };
}
