/**
 * 密钥在面板上的两件事:怎么遮、怎么生成。桥的 token 与声明式设置项的 `secret` / `generate`
 * (ADR-0019 决策 30)共用这一份 —— 各写一份的话,「八位及以下整段打点」那条迟早只被记起一半。
 */

/**
 * 屏幕上只留头尾各四位 —— 两条接入才分得出谁是谁,而全文不上屏。
 *
 * 🔴 **短的整段打点**:头四尾四加起来是八位,值只有八位或更短时这两截拼起来就是
 * 全文(四位的甚至原样印两遍)。我们自己生成的是 32 位,但手填的、从别处迁来的不是 ——
 * 分不出谁是谁只是不方便,把钥匙印在屏幕上是把那条 WS 端点的唯一防线交出去。
 */
export function maskSecret(value: string): string {
	if (value.length <= 8) return "•".repeat(Math.max(4, value.length));
	return `${value.slice(0, 4)}${"•".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
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
