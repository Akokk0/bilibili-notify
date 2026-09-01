/**
 * 自主升级的两个常量:**信任谁**,以及**去哪问**。
 *
 * 这两样都写死在代码里,不给配置入口 —— 它们是信任根,能被配置改掉的信任根不是
 * 信任根。用户能改的只有加速前缀(拼在下面这些地址前面)和渠道。
 */

/**
 * 内置信任列表:Ed25519 公钥的 SPKI DER,base64。
 *
 * **两把**是设计使然,且**必须从第一个发出去的版本起就都在里面**:
 *
 * - A —— 主用。进 CI secret(`BN_UPDATE_SIGNING_KEY`),同时离线留一份备份。
 * - B —— 备用。**永远不进 CI**,只躺在离线备份里。
 *
 * A 泄露时唯一的退路是用 B 签一版、把 A 踢出信任列表。而信任列表是**冻在已经发出去
 * 的那些安装里**的 —— 事后再加公钥救不了任何存量用户,他们的客户端只认自己出厂时
 * 带的那几把。所以 B 只有在第一版就在场,才有意义。
 *
 * 空列表 = 这个构建不做自主升级(fork 出去自己构建的人默认落在这里)。服务端会把它
 * 表述成「功能未启用」而不是「验签失败」—— 后者会让人去查一个根本不存在的安全问题。
 *
 * 生成方法见 `docs/agents/self-update.md`。
 */
export const TRUSTED_UPDATE_KEYS: readonly string[] = [];

const RELEASE_DOWNLOAD_BASE = "https://github.com/Akokk0/bilibili-notify/releases";

/**
 * 渠道清单的固定地址。
 *
 * 挂在一个**滚动的 release tag**(`update-channel`)上,而不是 `releases/latest/download/`:
 * 后者按定义指向最新的**正式**发布,预发布渠道就永远拿不到自己的那份清单。滚动 tag
 * 两个渠道都覆盖得到,而且不需要碰 `api.github.com`(代理站不代理 API,而且 API 的
 * 回答上没有我们的签名)。
 *
 * 和载荷本体同域同路径前缀,所以用户填**一条**加速前缀就同时管住清单和包。
 */
export const UPDATE_MANIFEST_URLS = {
	stable: `${RELEASE_DOWNLOAD_BASE}/download/update-channel/stable.json`,
	prerelease: `${RELEASE_DOWNLOAD_BASE}/download/update-channel/alpha.json`,
} as const;

/**
 * 连清单都拿不到时,唯一还能给用户的落脚点。
 *
 * 「下不动就通知 + 给个链接让他自己去下」是设计里的兜底出口 —— 那条链接必须在任何
 * 情况下都给得出来,包括我们对远端一无所知的时候。
 */
export const RELEASES_PAGE_URL = RELEASE_DOWNLOAD_BASE;
