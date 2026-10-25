import { type ConnectionCandidate, PLATFORM_REGISTRY } from "@bilibili-notify/internal";
import {
	ONEBOT_FORWARD_MIN_TIMEOUT_MS,
	ONEBOT_IMAGE_MIN_TIMEOUT_MS,
} from "@bilibili-notify/internal/platform-registry";

/**
 * 模板候选的 `settings`:新建一条连接时的默认值,按适配器键分。
 *
 * ⚠️ 这是 `apps/web/src/types/domain.ts` 的 `makeEmptyConnection` 里那份默认值的**第二份**,
 * 眼下面板还不读候选所以两边各有一份、会漂。第 4 期面板改读候选之后,删掉 `domain.ts` 那份
 * (记在 `docs/1.0/construction-plan.md` 第 4 期面板那一行)。
 *
 * 平台固定的适配器里只有 webhook 这一族每个平台的默认值一样;OneBot / QQ 官方各一个平台。
 */
const TEMPLATE_SETTINGS: Readonly<Record<string, unknown>> = {
	onebot: {
		transport: "http",
		baseUrl: "http://127.0.0.1:3000",
		protocolVersion: "v11",
		headers: {},
		timeoutMs: 15_000,
		imageMinTimeoutMs: ONEBOT_IMAGE_MIN_TIMEOUT_MS,
		mergeForwardMinTimeoutMs: ONEBOT_FORWARD_MIN_TIMEOUT_MS,
		maxRetries: 0,
		retryIntervalMs: 1_000,
	},
	"qq-official": {
		appId: "",
		appSecret: "",
		sandbox: false,
		botType: "public",
		logReconnects: false,
	},
	webhook: { url: "https://example.com/hook", headers: {} },
};

/**
 * 内置适配器的候选:平台注册表里归这个适配器的那几行(OneBot 一行、QQ 官方一行、webhook 四行)。
 * 三个内置适配器共用这一份取法,描述只住注册表,不在适配器里手抄;名字取注册表那一行的 `label`。
 * 每次造新的一份(`settings` 深拷),调用方改了不连累下一次。
 */
export function builtinCandidatesFor(adapterKey: string): readonly ConnectionCandidate[] {
	return Object.entries(PLATFORM_REGISTRY)
		.filter(([, row]) => row.adapterKey === adapterKey)
		.map(([platform, { adapterKey: _adapterKey, ...snapshot }]) => ({
			name: snapshot.label,
			platform: { platform, ...snapshot },
			settings: structuredClone(TEMPLATE_SETTINGS[adapterKey]),
		}));
}
