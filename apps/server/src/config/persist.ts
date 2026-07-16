import { readFile, rename, writeFile } from "node:fs/promises";
import { parseDocument } from "yaml";

/** dashboard 热启用卡片渲染时选定的浏览器来源:本地二进制路径或远程端点(至少一项)。 */
export interface ChromeSource {
	chromePath?: string;
	chromeEndpoint?: string;
}

/**
 * 运行时把浏览器来源(`chromePath` / `chromeEndpoint`)写回 bootstrap yaml ——
 * dashboard 探测到本地 Chrome、或填入远程端点并热启用卡片渲染后调用,使配置
 * 持久化(重启仍生效)。只写传入的字段,不清另一个 —— 运行时优先级(endpoint 赢)
 * 由 adapter 决定,yaml 里两个都留着方便用户切换。
 *
 * 用 yaml 的 `parseDocument`(Document API)而非 `parse`→`stringify`,以保留用户文件
 * 里的**注释与字段顺序** —— bn.config.yaml 的注释承载各 OS 的 Chrome 路径示例等说明,
 * 整段重写会丢掉。tmp + rename 保持原子写;mode 0o600(文件可能含 dashboard 凭据等
 * secret,仅 owner 可读)。
 */
export async function persistChromeSource(configPath: string, source: ChromeSource): Promise<void> {
	const doc = parseDocument(await readFile(configPath, "utf8"));
	if (source.chromePath) doc.set("chromePath", source.chromePath);
	if (source.chromeEndpoint) doc.set("chromeEndpoint", source.chromeEndpoint);
	const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, doc.toString(), { mode: 0o600, encoding: "utf8" });
	await rename(tmp, configPath);
}
