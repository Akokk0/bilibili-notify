import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseList, readArg, requireArg } from "./cli-args.mjs";
import { payloadUrl, releaseUrl } from "./release-urls.mjs";

/**
 * 撤回一个坏版本的两件事:**定规矩**和**取数**。
 *
 * 撤回是这条链路上唯一一件「出事那天才跑」的操作 —— 而那天没有人有心思复核一条
 * 手抄的长命令。此前它是文档里的一段步骤:去用户该被送去的那一版的 release 页上
 * 抄 sha256 和字节数、拼参数、跑两遍发布脚本。抄错一位的下场是签出一份指着校验和
 * 对不上的包的清单,于是所有人的「检查更新」开始报 `checksum-mismatch` ——
 * 也就是我们专门留给「有人在中间改包」的那一档归因。
 *
 * 所以这里只做纯粹的两半,workflow 那头不写任何判断:
 *
 * - `planRevocation` —— 参数对不对、要刷哪几条渠道、地址怎么拼。纯函数。
 * - `fetchPayloadDigest` —— sha256 与 size 从**真的那份已发布的包**上算出来。
 */

/** 与 `assert-ref-matches-standalone-version.sh` 认的是同一种形状:裸 semver,不带 `v`。 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const CHANNELS_BY_CHOICE = {
	stable: ["stable"],
	alpha: ["alpha"],
	// 正式版渠道被撤回时,预发布渠道的用户同样在跑那个坏版本 —— 两条都得刷,
	// 理由同 update-payload.yml 里「正式版同时刷 stable 与 alpha」那条。
	both: ["stable", "alpha"],
};

/**
 * @param {{repo: string, target: string, revoked: string, channel: string}} input
 *   `target` 是用户**该在**的那一版(修复版,或退回上一个好版本 —— 可以比坏版本号小);
 *   `revoked` 是逗号分隔的坏版本号。
 * @returns {{ok: true, version: string, revoked: string[], channels: string[], payloadUrl: string, releaseUrl: string} | {ok: false, error: string}}
 */
export function planRevocation({ repo, target, revoked, channel }) {
	const channels = CHANNELS_BY_CHOICE[channel];
	if (!channels) {
		return { ok: false, error: `渠道只认 stable / alpha / both,收到 '${channel}'` };
	}
	if (!VERSION_RE.test(target)) {
		return { ok: false, error: `目标版本号不成形(要裸 semver,不带 v):'${target}'` };
	}

	const list = parseList(revoked);
	if (list.length === 0) {
		return { ok: false, error: "没有要撤回的版本 —— 那不是撤回,是重发一遍清单" };
	}
	const malformed = list.find((v) => !VERSION_RE.test(v));
	if (malformed !== undefined) {
		return { ok: false, error: `撤回的版本号不成形:'${malformed}'` };
	}
	// 把用户要去的那一版自己也撤回了 —— 客户端会装上它、然后立刻把它删掉/判死,
	// 结果是所有人被推向一个不存在的落脚点。这是出事那天最容易犯的错。
	if (list.includes(target)) {
		return { ok: false, error: `目标版本 ${target} 自己也在撤回名单里` };
	}

	return {
		ok: true,
		version: target,
		revoked: list,
		channels,
		payloadUrl: payloadUrl(repo, target),
		releaseUrl: releaseUrl(repo, target),
	};
}

/**
 * 算出一份**已经发布**的载荷包的 sha256 与字节数。
 *
 * 取不到就抛 —— 签一份指着 404 的清单比不撤回更糟:客户端会一路走到下载才失败,
 * 而坏版本仍然在跑。
 *
 * @param {string} url
 * @param {typeof fetch} [fetchImpl] 注入是为了能测。
 */
export async function fetchPayloadDigest(url, fetchImpl = fetch) {
	const res = await fetchImpl(url);
	if (!res.ok) throw new Error(`取不到载荷 ${url}:HTTP ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
}

// CLI:把「该指向哪份包」解析成一组具体参数,交给 workflow 喂给 sign-update-manifest。
// 同 build-update-payload 的用法 —— 输出一份 JSON,workflow 用 `node -p` 取字段。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const plan = planRevocation({
		repo: requireArg("repo"),
		target: requireArg("target"),
		revoked: requireArg("revoked"),
		channel: readArg("channel", "both"),
	});
	if (!plan.ok) {
		process.stderr.write(`::error::${plan.error}\n`);
		process.exit(1);
	}
	// 从真的那份已发布的包上算 —— 这一步就是用来顶掉「去 release 页手抄 sha256」的。
	const digest = await fetchPayloadDigest(plan.payloadUrl);
	process.stdout.write(
		`${JSON.stringify(
			{
				version: plan.version,
				revoked: plan.revoked.join(","),
				channels: plan.channels.join(" "),
				payloadUrl: plan.payloadUrl,
				releaseUrl: plan.releaseUrl,
				...digest,
			},
			null,
			2,
		)}\n`,
	);
}
