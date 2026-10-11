/**
 * B 站报给主人的问题,给主人看的话都集中在这里,逻辑里不写整句(之后改字只动这一个文件)。
 *
 * 每条问题一个条目,带齐三样:
 * - `text`:进问题表、(私聊的话)说给主人的那一句,固定句或带参数的函数;
 * - `notify`:要不要私聊主人(`false` = 只进表);
 * - `recovery`:清掉时、当初真私聊过的话,核心补的那一句「恢复时怎么说」。只进表的条目不会被用到,所以不带。
 *
 * 口吻是女仆风格(主人定稿):交互与提示用女仆口吻,不加颜文字。
 */
export const PROBLEM_TEXTS = {
	/** 登录失效(运行中掉了,或开机发现存着的登录已失效):私聊 + 进表。 */
	loginExpired: {
		notify: true,
		text: "主人，B 站的登录失效了，动态和直播女仆都先停下了。麻烦主人到面板的账号页重新扫一下码（发登录指令也行），登录好了女仆马上接着干活。",
		recovery: "主人，好消息：B 站的登录已经恢复啦。",
	},
	/** 从没登录过、主动退出:只进表,不私聊。 */
	loginMissing: {
		notify: false,
		text: "主人还没有登录 B 站账号哦，动态和直播女仆暂时收不到。到面板的账号页扫码登录一下就好啦。",
	},
	/** 风控:私聊 + 进表。 */
	riskControlled: {
		notify: true,
		text: "主人，B 站暂时不让这个账号访问了（被风控了）。女仆会隔一阵自己再试，主人不用管；要是一直没好，可以试试重新登录，或者换个网络环境。",
		recovery: "主人，好消息：B 站的风控已经解除啦，女仆继续干活。",
	},
	/** 拉动态失败(风控以外的错误码,每 5 分钟自动重试):只进表,不私聊。 */
	dynamicFetchFailed: {
		notify: false,
		text: (code: number) =>
			`主人，女仆拉取 B 站动态失败了（错误码 ${code}），每 5 分钟会自己再试一次；一直不好的话，麻烦主人看看日志。`,
	},
	/** 直播间停止监听(取信息失败、弹幕连不上、重连用尽):私聊 + 进表。`reason` 是停下的原因。 */
	liveMonitorStopped: {
		notify: true,
		text: (roomId: string, reason: string) =>
			`主人，直播间 [${roomId}] 的监听停了：${reason}。把这位 UP 的直播相关开关全部关掉再打开，或者重启一下，女仆就能重新连上。`,
		recovery: (roomId: string) => `主人，好消息：直播间 [${roomId}] 的监听已经恢复啦。`,
	},
	/** 直播间停止监听时填进 `liveMonitorStopped.text` 的原因(调用点各取一条)。 */
	liveStopReasons: {
		/** 取直播间信息失败(含开播 / 下播 / 周期那几拍取信息失败)。 */
		roomInfo: "取直播间信息失败",
		/** 弹幕连接没建起来。 */
		danmakuConnect: "弹幕连接建立失败",
		/** 重连的秒级退避用完,放弃监听。 */
		gaveUp: "连接持续失败，重试 5 次后放弃",
	},
	/** 直播间受限(加密、付费、测试房、没权限):私聊 + 进表。`reason` 是 B 站给的原因。 */
	liveRoomRestricted: {
		notify: true,
		text: (roomId: string, reason: string) =>
			`主人，直播间 [${roomId}] 的弹幕女仆连不上：${reason}。可能是加密、付费、测试房，或者这个账号没有权限，这个房间女仆先不盯了。`,
		recovery: (roomId: string) => `主人，好消息：直播间 [${roomId}] 的弹幕女仆连上啦。`,
	},
} as const;
