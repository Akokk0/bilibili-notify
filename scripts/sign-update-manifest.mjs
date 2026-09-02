#!/usr/bin/env node
// 生成并签署升级清单。
//
// 产出两个文件:
//   - <out>.json      清单本体(**被签的就是这个文件的字节**,别再动它一个空格)
//   - <out>.sig.json  运输信封 `{ "manifest": "<上面那份的原文>", "signature": "<base64>" }`
//
// 信封本身从不被签 —— 被签的是 `manifest` 那串字符。所以信封可以随便重新排版、
// 换缩进、过 formatter,签名照样成立;而把清单展开成对象存放就会要求验签时重新
// 序列化,JSON 的重新序列化根本不唯一(键序/空白/数字写法/unicode 转义),两边差
// 一点就验不过且查不出原因。客户端那半边见 apps/server/src/update/。
//
// 私钥从 env 取,**永远不要写进命令行参数**(会进 CI 日志和 ps 输出)。
//
// 用法:
//   BN_UPDATE_SIGNING_KEY="$(cat key.pem)" node scripts/sign-update-manifest.mjs \
//     --version 0.9.0 --payload-url https://…/payload-0.9.0.zip \
//     --sha256 <hex> --size <bytes> --release-url https://…/tag/v0.9.0 \
//     --out dist/manifest

import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 发版侧的形状检查。
 *
 * **它是客户端 `ManifestSchema` 的一份手抄**(apps/server/src/update/signed-manifest.ts)
 * —— 两处实现不可能自动同步,所以防漂移靠的是
 * `scripts/sign-update-manifest.test.mjs`:那些测试把签出来的信封**真的交给客户端
 * 的 `loadSignedManifest`** 去验。客户端一旦收紧规则,这里签出来的东西会当场被拒,
 * 测试就红。
 *
 * 在这儿多设一道门,是因为清单发出去就收不回来,而客户端拒绝的表现是**所有人都
 * 升不上去**;在打包机上炸的代价只是重跑一次 CI。
 *
 * 残余风险照实说:客户端**放宽**规则时这边不会红(我们更严,不影响正确性);
 * 客户端**新增**必填字段时,只有测试里的 round-trip 会红。
 */
function assertManifestShape(m) {
	const fail = (msg) => {
		throw new Error(`manifest 不合规:${msg}`);
	};
	if (typeof m.version !== "string" || m.version === "") fail("version 必须是非空字符串");
	if (!Number.isInteger(m.issuedAt) || m.issuedAt <= 0) fail("issuedAt 必须是正整数(epoch 秒)");
	if (!m.payload || typeof m.payload !== "object") fail("缺 payload");
	const { url, sha256, size } = m.payload;
	if (typeof url !== "string" || !url.startsWith("https://"))
		fail(`payload.url 必须是 https:${url}`);
	// 小写 hex 64 位:客户端的比对是字符串相等,大写或长度不对就永远匹配不上。
	if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))
		fail(`payload.sha256 必须是 64 位小写 hex:${sha256}`);
	if (!Number.isInteger(size) || size <= 0) fail(`payload.size 必须是正整数:${size}`);
	if (typeof m.releaseUrl !== "string" || !m.releaseUrl.startsWith("https://"))
		fail(`releaseUrl 必须是 https:${m.releaseUrl}`);
	try {
		new URL(m.releaseUrl);
		new URL(url);
	} catch {
		fail("payload.url / releaseUrl 不是合法 URL");
	}
	return m;
}

/**
 * @param {{ version: string, payload: { url: string, sha256: string, size: number },
 *           releaseUrl: string, issuedAt?: number, notes?: string, revoked?: string[],
 *           requires?: { nodeMajor?: number } }} input
 */
export function buildManifest({
	version,
	payload,
	releaseUrl,
	issuedAt,
	notes,
	revoked,
	requires,
}) {
	// 可选字段**没传就不写进去**。写 `"notes": null` 会让客户端的 zod 直接判 malformed
	// (`.optional()` 收 undefined 不收 null),而那份清单是签得过的 —— 用户看到
	// 「清单损坏」,谁也想不到是这里多写了一个 null。
	const manifest = {
		version,
		payload: { url: payload.url, sha256: payload.sha256, size: payload.size },
		releaseUrl,
		// 签发时间(epoch 秒)。客户端记住见过的最大值、比它旧的不收 —— 没有它,加速站
		// 可以永远回放一份签过的旧清单,把用户钉在已撤回的版本上。
		issuedAt: issuedAt ?? Math.floor(Date.now() / 1000),
	};
	if (notes !== undefined) manifest.notes = notes;
	if (revoked !== undefined) manifest.revoked = revoked;
	if (requires !== undefined) manifest.requires = requires;
	return assertManifestShape(manifest);
}

/** CI secret 里 PEM 的换行最容易在传递中丢掉,所以也收 base64 包过一层的。 */
function readPrivateKey(raw) {
	if (!raw || raw.trim() === "") throw new Error("没拿到签名私钥(BN_UPDATE_SIGNING_KEY 为空)");
	const pem = raw.includes("-----BEGIN") ? raw : Buffer.from(raw.trim(), "base64").toString("utf8");
	let key;
	try {
		key = createPrivateKey(pem);
	} catch (err) {
		throw new Error(`签名私钥读不出来:${err instanceof Error ? err.message : String(err)}`);
	}
	// RSA / EC 私钥都是合法 PEM,签出来的东西内置的 Ed25519 公钥一个也验不了。
	// 与其发出去让全世界验签失败,不如在发版机上死。
	if (key.asymmetricKeyType !== "ed25519")
		throw new Error(`签名私钥必须是 ed25519,拿到的是 ${key.asymmetricKeyType}`);
	return key;
}

/**
 * @returns {{ manifestJson: string, envelopeJson: string,
 *             envelope: { manifest: string, signature: string } }}
 */
export function signManifest(manifest, privateKeyPem) {
	const key = readPrivateKey(privateKeyPem);
	// 两个空格缩进只是为了人能读。**签的是这串字符本身**,所以这里的排版一旦定了,
	// 就不能在写文件时再动它(比如别用 `JSON.stringify(JSON.parse(x))` 过一遍)。
	const manifestJson = JSON.stringify(manifest, null, 2);
	const signature = cryptoSign(null, Buffer.from(manifestJson, "utf8"), key).toString("base64");
	const envelope = { manifest: manifestJson, signature };
	return { manifestJson, envelopeJson: JSON.stringify(envelope, null, 2), envelope };
}

function readArg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
	const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
	if (inline) return inline.slice(name.length + 3);
	return fallback;
}

function requireArg(name) {
	const value = readArg(name);
	if (!value) throw new Error(`缺参数 --${name}`);
	return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const revokedArg = readArg("revoked", "");
	const nodeMajorArg = readArg("requires-node-major", "");
	const manifest = buildManifest({
		version: requireArg("version"),
		payload: {
			url: requireArg("payload-url"),
			sha256: requireArg("sha256"),
			size: Number(requireArg("size")),
		},
		releaseUrl: requireArg("release-url"),
		issuedAt: readArg("issued-at") ? Number(readArg("issued-at")) : undefined,
		notes: readArg("notes"),
		revoked: revokedArg
			? revokedArg
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean)
			: undefined,
		requires: nodeMajorArg ? { nodeMajor: Number(nodeMajorArg) } : undefined,
	});

	const { manifestJson, envelopeJson } = signManifest(manifest, process.env.BN_UPDATE_SIGNING_KEY);
	const out = resolve(readArg("out", "dist/manifest"));
	await mkdir(dirname(out), { recursive: true });
	await writeFile(`${out}.json`, manifestJson, "utf8");
	await writeFile(`${out}.sig.json`, envelopeJson, "utf8");
	process.stdout.write(`signed ${manifest.version} → ${out}.json / ${out}.sig.json\n`);
}
