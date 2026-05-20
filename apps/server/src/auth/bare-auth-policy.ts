/**
 * 决策"是否拒绝以无 basicAuth 状态启动 dashboard"的纯函数。
 *
 * 抽出来是为了能单元测试这个安全策略 —— index.ts 里调用方拿到 true 后执行
 * `process.exit(1)`,直接测调用方需要 mock process.exit + bootstrap 序列,得不偿失。
 *
 * 三条路径:
 *   - 已配置 basicAuth → false(放行,不需要拒绝)
 *   - 监听 loopback(127.0.0.1 / localhost / ::1)→ false(本地裸跑 OK)
 *   - 显式逃生口 BN_ALLOW_NO_AUTH=1 → false(运维已经在反代层做了别的鉴权)
 *   - 其余(non-loopback + 无 basicAuth + 无逃生口)→ true,拒绝启动
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);

export interface BareAuthPolicyInput {
	host: string;
	hasBasicAuth: boolean;
	allowNoAuth: boolean;
}

export function shouldRefuseBareAuth(input: BareAuthPolicyInput): boolean {
	if (input.hasBasicAuth) return false;
	if (input.allowNoAuth) return false;
	if (LOOPBACK_HOSTS.has(input.host)) return false;
	return true;
}
