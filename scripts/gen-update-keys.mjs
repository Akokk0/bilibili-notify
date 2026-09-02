#!/usr/bin/env node
// 生成自主升级要用的**两把** Ed25519 密钥,并打印该往哪儿贴。
//
// 为什么不用 `openssl genpkey -algorithm ed25519`:macOS 自带的 `openssl` 其实是
// LibreSSL(实测 3.3.6),它**不认 ed25519** —— 只回一句 `Algorithm ed25519 not found`
// 就退出,而且**退出码是 0**,于是脚本会一路往下走到「文件不存在」才报错,把人指向
// 完全错误的方向。Node 就在手边,而且和 `sign-update-manifest.mjs` 用的是同一套
// crypto,格式一定对得上。
//
// 用法(**建议生成到仓库外面**,私钥不该躺在工作树里):
//   node scripts/gen-update-keys.mjs --out ~/secrets/bn-update
//
// 产出 <out>-A.pem 与 <out>-B.pem(mode 0600),并打印两把公钥的 SPKI base64。

import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readArg } from "./cli-args.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `~` 是 shell 展开的;直接当参数传进来时得自己认。 */
function expandHome(p) {
	return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

const outBase = expandHome(readArg("out", "bn-update"));
const targets = ["A", "B"].map((role) => ({ role, path: `${outBase}-${role}.pem` }));

// 覆盖一把已存在的私钥是**不可逆**的:签名列表里那把公钥从此再也配不上私钥,
// 而已经发出去的安装只认那把公钥。宁可让人自己挪走旧文件。
const clashes = targets.filter((t) => existsSync(t.path));
if (clashes.length > 0) {
	console.error(`拒绝覆盖已存在的密钥:\n${clashes.map((c) => `  ${c.path}`).join("\n")}`);
	console.error("覆盖私钥是不可逆的 —— 先把旧的挪走,或换一个 --out。");
	process.exit(1);
}

const insideRepo = !relative(repoRoot, outBase).startsWith("..");

mkdirSync(dirname(outBase), { recursive: true });

const publicKeys = targets.map(({ role, path }) => {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	// 0600:私钥只对 owner 可读。
	writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
	return { role, path, spki: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
});

console.log("已生成两把 Ed25519 密钥:");
for (const { role, path } of publicKeys) console.log(`  ${role} → ${path}`);

if (insideRepo) {
	console.log("");
	console.log("⚠️  这两个文件在仓库工作树里,而 .gitignore 没有 *.pem 规则 ——");
	console.log("    一次 `git add -A` 就会把私钥提交上去。请挪到仓库外面。");
}

console.log("");
console.log("① 两把公钥填进 apps/server/src/update/trusted-keys.ts 的 TRUSTED_UPDATE_KEYS:");
console.log("");
console.log("export const TRUSTED_UPDATE_KEYS: readonly string[] = [");
for (const { role, spki } of publicKeys) console.log(`\t"${spki}", // ${role}`);
console.log("];");
console.log("");
console.log("② 私钥 A 进 CI(base64 包一层,PEM 换行在 secret 里会丢):");
console.log("");
console.log(`   base64 < ${publicKeys[0].path} | gh secret set BN_UPDATE_SIGNING_KEY`);
console.log("");
console.log("③ 两把 .pem 各离线存一份(密码管理器 / 冷存储)。**B 永远不进 CI** ——");
console.log("   A 泄露时,用 B 签一版把 A 踢出信任列表是唯一的退路。");
