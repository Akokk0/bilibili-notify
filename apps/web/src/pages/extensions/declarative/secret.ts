/**
 * 密钥在面板上的两件事:存着的那一把怎么画(见 `components/secret-cell.tsx`)、新的一把怎么生成。声明式设置项的 `secret` / `generate`
 * (ADR-0019 决策 30)在设置表单、列表卡、新建弹窗里共用这一份。
 */

// `maskedOf` 搬去了 `components/secret-cell.tsx`(连接表单、智能女仆页也要用);这里转出,拓展页的
// 老引用与它的测试不动。
export { maskedOf } from "../../../components/secret-cell";

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
