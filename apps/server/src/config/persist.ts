import { readFile, rename, writeFile } from "node:fs/promises";
import { parseDocument } from "yaml";

/**
 * 运行时把 `chromePath` 写回 bootstrap yaml —— dashboard 自动探测到本地 Chrome 并
 * 热启用卡片渲染后调用,使配置持久化(重启仍生效)。
 *
 * 用 yaml 的 `parseDocument`(Document API)而非 `parse`→`stringify`,以保留用户文件
 * 里的**注释与字段顺序** —— bn.config.yaml 的注释承载各 OS 的 Chrome 路径示例等说明,
 * 整段重写会丢掉。tmp + rename 保持原子写;mode 0o600(文件可能含 dashboard 凭据等
 * secret,仅 owner 可读)。
 */
export async function persistChromePath(configPath: string, chromePath: string): Promise<void> {
	const doc = parseDocument(await readFile(configPath, "utf8"));
	doc.set("chromePath", chromePath);
	const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, doc.toString(), { mode: 0o600, encoding: "utf8" });
	await rename(tmp, configPath);
}
