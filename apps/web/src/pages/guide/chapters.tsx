import { WarnNote } from "@bilibili-notify/ui";
import { Link } from "react-router-dom";
import { GdH2, GdK, GdP, GdSteps, GdTable } from "./prose";

/**
 * 新手指引的短章节:总览(含 QQ 选型表)/B站登录/订阅/图片渲染/AI。
 * QQ 双路教程(重头戏)单独在 chapter-push.tsx。章节与流程顺序跟导览主步
 * 一致:登录 → 推送通道(适配器/目标/测试) → 订阅 —— 订阅表单要勾推送目标,
 * 通道没就绪先订阅就得回头返工。
 *
 * 内容原则(grilling 定案):完整内嵌不依赖外链承载正文;细节外链只指官方
 * (NapCat 官方/腾讯官方),不链第三方教程。
 */

export function ChapterOverview() {
	return (
		<div>
			<GdP>
				欢迎使用 bilibili-notify(BN)!这份指引带你从零走到「QQ 里收到第一条推送」。
				配置一共五步,左缘的「指引」导览会实时探测完成状态并自动推进,全部变绿就毕业啦。
			</GdP>
			<GdSteps>
				<li>
					<b>登录 B 站账号</b> —— 在「系统」页扫码,BN 用它拉取订阅 UP 的动态与直播状态。
				</li>
				<li>
					<b>配置推送适配器</b> —— 把 BN 接上你的 QQ 机器人(或 webhook),并点「测试」验证连通。
				</li>
				<li>
					<b>添加推送目标</b> —— 指定消息发到哪个群 / 哪个人。
				</li>
				<li>
					<b>发送测试推送</b> —— 在目标上点「测试」,QQ 里收到消息即通道打通。
				</li>
				<li>
					<b>订阅第一个 UP</b> —— 在「订阅」页搜索并添加想关注的 UP 主,订阅上即毕业。
				</li>
			</GdSteps>
			<GdP>为什么订阅放最后?订阅表单里就要勾选推送目标 —— 先把通道打通,订阅一步到位。</GdP>
			<GdH2>QQ 接入选型:两条路怎么选</GdH2>
			<GdP>
				BN 支持两种接 QQ 的方式,<b>先选对路再动手</b>,它们的能力与成本完全不同:
			</GdP>
			<GdTable
				head={["判据", "qq-official(官方机器人)", "onebot(NapCat 等协议端)"]}
				rows={[
					[
						<b key="k">要不要群推送</b>,
						"按 bot 等级分层:扫码一键建的轻量 bot=自己私聊+自己当群主的群;过审 bot、企业主体逐级放宽(以官方政策为准)",
						"✅ 群聊 / 私聊都行,拉群自由",
					],
					[
						<b key="k">额外部署</b>,
						"零额外部署,BN 直连腾讯官方接口",
						"要多跑一个协议端容器(NapCat / Lagrange)",
					],
					[
						<b key="k">风控 / 封号风险</b>,
						"无 —— 官方 API,不碰你的 QQ 账号",
						"协议端要登录一个 QQ 号,有风控与封号风险,建议用小号",
					],
					[
						<b key="k">消息形态</b>,
						"文字为主;图片要走可公网访问的 URL,markdown 受权限限制",
						"图文自由,渲染出的卡片图直接发",
					],
				]}
			/>
			<GdP>
				一句话建议:<b>轻量自用</b> → 走 qq-official 的「扫码一键创建」,五分钟搞定;
				<b>重度群推 / 想要图片卡片</b> → 走 onebot + NapCat。两条路的手把手教程都在
				<Link to="/about/guide/push" className="text-bn-pink hover:underline">
					推送通道
				</Link>
				一章。
			</GdP>
			<GdP>
				不用 QQ?BN 还有 <b>webhook</b> 适配器(钉钉 / 飞书 / 企业微信 / 通用
				JSON),同样在推送通道一章。
			</GdP>
		</div>
	);
}

export function ChapterLogin() {
	return (
		<div>
			<GdP>BN 需要一个 B 站账号来拉取订阅 UP 的动态、直播与粉丝数据。</GdP>
			<GdSteps>
				<li>
					打开
					<Link to="/system" className="text-bn-pink hover:underline">
						系统
					</Link>
					页,找到「B 站账号」区域,点「扫码登录」。
				</li>
				<li>用手机 B 站 App 扫码并确认。</li>
				<li>页面显示已登录、头像出现,即完成 —— 左缘导览会自动进入下一步。</li>
			</GdSteps>
			<GdH2>常见问题</GdH2>
			<GdP>
				<b>登录后会不会掉?</b> BN 会自动轮换刷新 cookie,正常情况无需重复扫码;若显示登录
				失效,回系统页重扫一次即可。
			</GdP>
			<GdP>
				<b>接口报 -352?</b> 这是 B 站的风控码,通常出现在新登录或请求频繁时 ——
				等待一段时间会自行恢复,不需要反复重登(反复登录反而更容易触发)。
			</GdP>
			<WarnNote className="mt-2">
				BN 的所有数据都存在你自己的服务器上,登录凭据加密落盘、不上传任何第三方 —— 但也请别把 BN
				面板裸暴露在公网,给 dashboard 设访问密码。
			</WarnNote>
		</div>
	);
}

export function ChapterSubs() {
	return (
		<div>
			<GdP>
				订阅决定 BN 帮你盯谁 —— 动态、开播、下播总结都从订阅列表出发。它是五步里的
				<b>最后一步</b>:订阅表单要勾选推送目标,先按
				<Link to="/about/guide/push" className="text-bn-pink hover:underline">
					推送通道
				</Link>
				一章把通道打通,订阅就能一步到位。
			</GdP>
			<GdSteps>
				<li>
					打开
					<Link to="/subs" className="text-bn-pink hover:underline">
						订阅
					</Link>
					页,搜索 UP 主昵称或 UID,点「订阅」。
				</li>
				<li>在订阅表单里勾上此前建好的推送目标 —— 这决定这位 UP 的消息发到哪。</li>
				<li>
					在订阅卡上按需开关功能:动态推送、直播开播 / 下播、直播弹幕总结等,每位 UP 可以单独配置。
				</li>
				<li>订阅数 ≥ 1 后,导览五步全绿 —— 毕业!之后动态与开播会自动推送。</li>
			</GdSteps>
		</div>
	);
}

export function ChapterRender() {
	return (
		<div>
			<GdP>
				图片渲染让推送从纯文字升级成漂亮的卡片图(动态卡 / 开播卡 / 总结卡)。
				<b>强烈推荐开启</b>,但不开也不影响毕业 —— 不开时 BN 自动退回文字推送。
			</GdP>
			<GdH2>按部署形态开启</GdH2>
			<GdP>
				<b>标准 Docker 镜像(默认)</b>:内置 Chromium,开箱即用 —— 到
				<Link to="/cards" className="text-bn-pink hover:underline">
					卡片
				</Link>
				页打开「图片渲染」开关,点「发送测试推送」看效果即可。
			</GdP>
			<GdP>
				<b>slim 镜像</b>(tag 带 <GdK>-slim</GdK>):镜像里没有浏览器,需要在环境变量
				<GdK>BN_CHROME_ENDPOINT</GdK> 指向一个远程浏览器(如 browserless
				伴随容器),不配置则保持文字推送。
			</GdP>
			<GdP>
				<b>非 Docker 部署</b>:在系统页配置本机 Chrome / Chromium 路径,或同样走远程浏览器。
			</GdP>
			<GdP>
				导览「图片渲染」尾巴的判据是:渲染器可用<b>且</b>卡片渲染开关已打开。
			</GdP>
		</div>
	);
}

export function ChapterAi() {
	return (
		<div>
			<GdP>
				AI 是 BN 的可选增强:直播弹幕总结、动态锐评、榜单周报、以及右下角的 AI
				女仆聊天。不配置完全不影响推送主链路。
			</GdP>
			<GdSteps>
				<li>
					打开
					<Link to="/ai" className="text-bn-pink hover:underline">
						AI
					</Link>
					页,选择服务商(OpenAI 兼容端点 / DeepSeek / 阿里百炼等),填 API Key 与模型。
				</li>
				<li>用页内「测试」面板发一句话验证连通。</li>
				<li>打开「启用 AI」总开关,再按需开启各功能(总结 / 锐评 / 聊天)。</li>
			</GdSteps>
			<GdP>
				导览「AI 能力」尾巴的判据是:密钥配置齐全<b>且</b>总开关已开。
			</GdP>
		</div>
	);
}
