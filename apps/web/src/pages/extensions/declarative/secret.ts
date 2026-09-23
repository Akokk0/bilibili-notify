/**
 * 密钥在面板上的两件事:存着的那一把怎么画、新的一把怎么生成。声明式设置项的 `secret` / `generate`
 * (ADR-0019 决策 30)在设置表单、列表卡、新建弹窗里共用这一份。
 */

/**
 * 存着的一格密钥在屏幕上的样子 —— **服务端算好的那一串**(`{ masked }`,决策 35 / 38)。空着(没配、
 * 脱敏备份恢复回来的)交 `undefined`,面板要分得开「没配」与「配了」。
 *
 * 🔴 面板**不再自己截头尾**:浏览器手里本来就没有全文。万一下发的不是遮挡的形状(面板比服务端新的
 * 那几秒、手改过的文件),一律画一串点 —— 一格声明成密钥的值,不管长什么样都不原样上屏。
 */
export function maskedOf(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "object" && !Array.isArray(value)) {
		const masked = (value as { masked?: unknown }).masked;
		if (typeof masked === "string") return masked;
	}
	return "•".repeat(8);
}

/**
 * 一把新钥匙:**128 位随机、32 位小写十六进制**(格式由 BN 定,ADR-0019 决策 30)。前端现生成 ——
 * token 只需要「两边一样」,不需要服务端参与(ADR-0009)。而桥那条 WS 端点**刻意在 dashboard
 * 鉴权之外**,所以这把钥匙的随机性就是它唯一的防线。
 *
 * 与 `newId()` 同一个理由不用 `crypto.randomUUID()`:那个只在 secure context 里有,
 * 而独立端常经 `http://<内网 IP>:8787` 访问。
 */
export function newHexSecret(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
