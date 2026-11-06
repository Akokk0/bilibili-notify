import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createSerialQueue } from "@bilibili-notify/internal";
import { atomicWriteFile } from "@bilibili-notify/storage";
import { type Document, parseDocument } from "yaml";

const writes = createSerialQueue();

/** 同一配置文件的两个写口共用完整读改写队列；不同文件互不等待，失败不阻断后续写入。 */
function updateBootstrapConfig(configPath: string, update: (doc: Document) => void): Promise<void> {
	const path = resolve(configPath);
	return writes.run(path, async () => {
		const doc = parseDocument(await readFile(path, "utf8"));
		update(doc);
		await atomicWriteFile(path, doc.toString(), { mode: 0o600 });
	});
}

/** dashboard 热启用卡片渲染时选定的浏览器来源:本地二进制路径或远程端点(至少一项)。 */
export interface ChromeSource {
	chromePath?: string;
	chromeEndpoint?: string;
}

/**
 * 运行时把浏览器来源(`chromePath` / `chromeEndpoint`)写回 bootstrap yaml ——
 * dashboard 探测到本地 Chrome、或填入远程端点并热启用卡片渲染后调用,使配置
 * 持久化(重启仍生效)。`source` 是切换后的**完整新状态**:未传的字段清空 ——
 * 启动期选择逻辑(index.ts)固定 chromeEndpoint 优先,若只写新字段留旧字段,
 * 用户从远程切回本地后一重启会悄悄退回旧的远程端点,与刚做的切换相反。
 *
 * 用 yaml 的 `parseDocument`(Document API)而非 `parse`→`stringify`,以保留用户文件
 * 里的**注释与字段顺序** —— bn.config.yaml 的注释承载各 OS 的 Chrome 路径示例等说明,
 * 整段重写会丢掉。经 storage 的 `atomicWriteFile` 原子写;mode 0o600(文件可能含 dashboard
 * 凭据等 secret,仅 owner 可读)。
 */
export async function persistChromeSource(configPath: string, source: ChromeSource): Promise<void> {
	return updateBootstrapConfig(configPath, (doc) => {
		if (source.chromePath) doc.set("chromePath", source.chromePath);
		else doc.delete("chromePath");
		if (source.chromeEndpoint) doc.set("chromeEndpoint", source.chromeEndpoint);
		else doc.delete("chromeEndpoint");
	});
}

/**
 * 面板改账号密码时把新凭据写回 bootstrap yaml 的 `auth.basicAuth`(第 4 期)。与 {@link persistChromeSource}
 * 同一套写法:Document API 保留注释与字段顺序,原子写,mode 0o600。写到哪由调用方定
 * (`resolveCredentialsTarget`:旧式部署的环境变量、没有配置文件时不写)。
 */
export async function persistDashboardCredentials(
	configPath: string,
	creds: { username: string; password: string },
): Promise<void> {
	return updateBootstrapConfig(configPath, (doc) => {
		doc.setIn(["auth", "basicAuth", "username"], creds.username);
		doc.setIn(["auth", "basicAuth", "password"], creds.password);
	});
}
