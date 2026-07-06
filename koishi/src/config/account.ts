import { DEFAULT_HEALTH_CHECK_MINUTES } from "@bilibili-notify/internal";
import { Schema } from "koishi";

export interface AccountConfig {
	logLevel: number;
	userAgent?: string;
	loginHealthCheckMinutes: number;
	/**
	 * 注入的静态加密口令。设置后 secrets(B 站 cookie / AI apiKey)用它经 scrypt
	 * 派生 AES-256 密钥加密,密钥本身不落盘 → 真正的静态加密;留空则回退到与密文
	 * 同目录的随机密钥(仅混淆,不构成真正的加密)。对齐 standalone 端的
	 * bootstrap.cookieEncryptionKey / BN_COOKIE_KEY。
	 */
	cookieEncryptionKey?: string;
}

export const AccountConfigSchema: Schema<AccountConfig> = Schema.object({
	logLevel: Schema.number()
		.min(1)
		.max(3)
		.step(1)
		.default(1)
		.description(
			"这里可以设置日志等级喔～3 是最详细的调试信息，1 是只显示错误信息。主人可以根据需要选择合适的等级，让女仆更好地为您服务 (๑•̀ㅂ•́)و✧",
		),

	userAgent: Schema.string().description(
		"这里可以设置请求头的 User-Agent 哦～如果请求出现了 -352 的奇怪错误，主人可以试着在这里换一个看看 (；>_<)",
	),

	loginHealthCheckMinutes: Schema.number()
		.min(5)
		.max(180)
		.step(1)
		.default(DEFAULT_HEALTH_CHECK_MINUTES)
		.description(
			"登录状态周期检测的间隔（分钟）。女仆会按这个频率悄悄帮主人确认账号还在线哦～如果发现失效会立刻汇报呢 (๑•̀ㅂ•́)و✧",
		),

	cookieEncryptionKey: Schema.string()
		.role("secret")
		.description(
			"静态加密口令～设置后女仆会用它派生 AES-256 密钥，把主人的 B 站 Cookie / AI apiKey 真正加密保存，密钥本身不落盘 (๑•̀ㅂ•́)و✧ 留空的话女仆只能用本地随机密钥简单混淆一下，安全性会差很多哒 (；>_<) 💡 主人可以在终端跑 `openssl rand -base64 32`（或 `node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`）生成一串足够随机的口令哦～ ⚠️ 一旦设置请务必妥善保管、不要随意改动或清空，否则之前加密的内容就解不开了，需要重新登录呢……",
		),
}).description("账号 · 登录 · 加密");
