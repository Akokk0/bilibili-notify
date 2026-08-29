import { ErrorNote, WarnNote } from "@bilibili-notify/ui";
import { Link } from "react-router-dom";
import { GdCode, GdH2, GdH3, GdK, GdP, GdSteps } from "./prose";

/**
 * /guide/push —— QQ 双路 + webhook 的完整教程(grilling 定案的重头戏):
 * 内容完整内嵌、只写 Docker 路线、无截图;细节外链只指官方(NapCat / 腾讯)。
 * 坑清单素材:BN 自身实测(源码注释与 issue)+ AstrBot 文档提炼(用自己的话写)。
 */

export function ChapterPush() {
	return (
		<div>
			<GdP>
				这一章覆盖进度卡的第三、四、五步:接好推送通道 → 指定目标 → 测试毕业。 还没想好走哪条路?先看
				<Link to="/guide" className="text-bn-pink hover:underline">
					总览的选型表
				</Link>
				:只推给自己选 A,要群推 / 图片卡片选 B。
			</GdP>

			{/* ---------------- A. qq-official ---------------- */}
			<GdH2>路线 A:QQ 官方机器人(qq-official)</GdH2>
			<GdP>
				走腾讯官方 Bot 接口,不碰你的 QQ 账号、零风控风险、零额外部署。代价是能力受
				官方限制:扫码一键建的轻量 bot <b>只能给创建者本人私聊发消息、不能拉群</b>。
			</GdP>

			<GdH3>A1 · 最快路径:扫码一键创建</GdH3>
			<GdSteps>
				<li>
					打开
					<Link to="/targets" className="text-bn-pink hover:underline">
						推送目标
					</Link>
					页 → 添加适配器 → 平台选「QQ 官方机器人」。
				</li>
				<li>
					点表单里的「<b>扫码一键创建</b>」(实验性),用手机 QQ 扫码,在腾讯页面里确认创建。 页面上出现
					OpenClaw / 小龙虾字样属正常 —— 这是腾讯给轻量 bot 开的通道。
				</li>
				<li>
					创建成功后 appId / appSecret 自动回填进表单,<b>点「保存」</b>落盘(不保存不生效)。
				</li>
				<li>保存后在适配器上点「测试」,通过则进度卡第三步变绿。</li>
			</GdSteps>
			<WarnNote className="mb-2">
				轻量 bot 的边界:仅创建者 C2C 私聊可用、不能拉群、无审核环节;每个 QQ 号最多创建 5
				个;凭据丢了重新扫码可找回(可重选已建的 bot 重发密钥)。要群推送请走 A2 正式注册或路线 B。
			</WarnNote>

			<GdH3>A2 · 正式路径:开放平台注册</GdH3>
			<GdSteps>
				<li>
					在 <GdK>q.qq.com</GdK> 注册开放平台账号并创建机器人(名称 / 简介 / 头像,需过审)。
				</li>
				<li>
					「开发 → 开发设置」里拿 <GdK>AppID</GdK> 与 <GdK>AppSecret</GdK>,填进 BN 的适配器表单。
				</li>
				<li>
					同一页配置 <b>IP 白名单</b>:填你服务器的公网出口 IP(服务器上执行
					<GdK>curl ifconfig.me</GdK> 可得)。
				</li>
				<li>
					测试期先在平台配置<b>沙箱</b>(指定 ≤20 人的群 / 私聊作为测试环境),BN 表单里勾选 sandbox
					与之对应;转正式后记得把 sandbox 关回去。
				</li>
			</GdSteps>
			<ErrorNote className="mb-2">
				IP 白名单是最常见的静默死法:家庭宽带的动态 IP 一变,发消息就开始报权限错误 ——
				官方路线请部署在有固定公网 IP 的服务器上,或每次 IP 变动后去平台更新白名单。
			</ErrorNote>

			<GdH3>A3 · 建目标与官方路线的坑</GdH3>
			<GdSteps>
				<li>
					适配器测试通过后,添加推送目标:群聊填 <GdK>groupOpenid</GdK>、私聊填
					<GdK>userOpenid</GdK>。
				</li>
				<li>
					这两个 openid <b>不是群号 / QQ 号,没法手填</b> —— 先在 QQ 里给机器人发一句话 (群里 @
					它,或私聊它),BN 收到入站事件后会在目标表单里给出可选的会话。
				</li>
				<li>在目标上点「测试」,QQ 里收到消息即毕业。</li>
			</GdSteps>
			<GdP>
				其他已知行为:网关每约 30 分钟主动要求重连一次,日志里的 RECONNECT
				属正常协议行为;图片消息需要图片可通过公网 URL 访问,BN 会自动处理渲染图的中转,但 markdown
				排版能力受 bot 类型(公域 / 私域)权限限制,轻量 bot 无私域特权。
			</GdP>

			{/* ---------------- B. onebot / NapCat ---------------- */}
			<GdH2>路线 B:OneBot 协议端(NapCat)</GdH2>
			<GdP>
				协议端用一个真实 QQ 号收发消息,群聊 / 私聊 / 图片全都自由。代价:多跑一个容器,且
				<b>协议端登号有风控与封号风险</b>。
			</GdP>
			<ErrorNote className="mb-2">
				强烈建议用小号 —— 协议端本质是模拟客户端登录,存在封号可能,别拿主号冒险。
			</ErrorNote>

			<GdH3>B1 · 部署 NapCat(Docker)</GdH3>
			<GdP>与 BN 同一台服务器上,docker compose 起一个 NapCat:</GdP>
			<GdCode>{`services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    restart: unless-stopped
    environment:
      - NAPCAT_UID=1000
      - NAPCAT_GID=1000
    ports:
      - "6099:6099"   # WebUI
    volumes:
      - ./napcat/config: /app/napcat/config
      - ./napcat/qq: /app/.config/QQ`}</GdCode>
			<GdSteps>
				<li>
					启动后浏览器打开 <GdK>http://服务器IP:6099/webui</GdK>,首次登录 token 看容器日志 (
					<GdK>docker logs napcat</GdK>)。
				</li>
				<li>在 WebUI 里用小号扫码登录 QQ。</li>
				<li>
					镜像与参数以
					<a
						href="https://github.com/NapNeko/NapCatQQ"
						target="_blank"
						rel="noreferrer"
						className="text-bn-pink hover:underline"
					>
						NapCat 官方文档
					</a>
					为准(协议端更新较快,以上模板写作时有效)。
				</li>
			</GdSteps>
			<WarnNote className="mb-2">
				千万别把 NapCat 的端口(WebUI 或 WS)裸暴露到公网 —— 它拿着你的 QQ 登录态。只在内网 / Docker
				网络内互通,必要时配 accessToken。
			</WarnNote>

			<GdH3>B2 · 连接 BN(推荐反向 WS)</GdH3>
			<GdP>
				BN 的 onebot 适配器支持三种连接方式,<b>推荐反向 WS</b>(BN 开端口等 NapCat 连进来,NapCat
				重启自动重连,最省心):
			</GdP>
			<GdSteps>
				<li>
					BN 侧:添加适配器 → 平台选 OneBot → 连接方式选「反向 WS」→ 填一个监听端口(如
					<GdK>6199</GdK>),保存。
				</li>
				<li>
					NapCat 侧:WebUI → 网络配置 → 新建「Websocket 客户端」,URL 填
					<GdK>ws://BN所在主机:6199/</GdK>,消息格式选 <b>Array</b>,启用。
				</li>
				<li>
					两边都是 Docker 且在同一台机器?把两个容器接进同一个 docker 网络,URL 写
					<GdK>ws://容器名:端口/</GdK> 直连,不用绕宿主机 IP。
				</li>
				<li>回 BN 在适配器上点「测试」,通过则第三步变绿。</li>
			</GdSteps>
			<GdP>
				另外两种方式:「正向 WS」= BN 主动连 NapCat 开的 WS 服务(URL 形如
				<GdK>ws://napcat:3001</GdK>);「HTTP」= BN POST 到 NapCat 的 HTTP 服务(需要 NapCat 同时开
				HTTP 服务端与上报)。配置了 accessToken 的话,两端必须一致。
			</GdP>

			<GdH3>B3 · 建目标与协议端的坑</GdH3>
			<GdSteps>
				<li>
					添加推送目标:群聊填群号(<GdK>groupId</GdK>),私聊填 QQ 号(<GdK>userId</GdK>) ——
					协议端路线可以直接手填。
				</li>
				<li>在目标上点「测试」,QQ 里收到消息即毕业。</li>
			</GdSteps>
			<GdP>
				已知行为:<b>带图消息发送慢是正常的</b> —— 协议端要先把图上传到 QQ 图床,实测经常超过 15 秒,BN
				已为带图消息单独放宽超时,不用改配置;若测试报「疑似 NapCat 未连接」,先去 WebUI
				看登录态与网络配置是否还在线。
			</GdP>

			{/* ---------------- C. webhook ---------------- */}
			<GdH2>路线 C:Webhook(不用 QQ)</GdH2>
			<GdP>
				添加 webhook 适配器,填目标 URL 即可 —— 支持钉钉 / 飞书 / 企业微信的群机器人格式与通用
				JSON(BN 原生 envelope,自己的服务随便接)。带 secret 的平台把签名密钥填上;
				同样点「测试」验证。
			</GdP>

			<GdH2>毕业检查</GdH2>
			<GdP>
				回到
				<Link to="/targets" className="text-bn-pink hover:underline">
					推送目标
				</Link>
				页,在目标行点「测试」—— QQ(或 webhook 端)收到测试消息,首页进度卡即全绿毕业 🎉 之后订阅 UP
				的动态与开播就会自动推送到这里。
			</GdP>
		</div>
	);
}
