/**
 * 指令分发器 —— 主人在私聊里敲的指令,从这里认出来、校验参数、交出去。
 *
 * 这里守的重点是**口子有多窄**。通用分发器天生想对未知输入给回音(「无此指令」),
 * 而任何回音都是接口指纹 —— 试探者靠报错差异就能摸出指令表,而这条私聊通道的对面
 * 是主人的 B 站账号与推送控制权。所以顺序被钉死为**鉴权在前、解析在后**:
 * 没过门的连一个字都收不到,过了门的才有完整的报错与用法提示。
 *
 * 下面每条「静默」断言都在钉这件事:不只是「没执行」,而是**连 reply 都没有**。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { createCommandDispatcher } from "../command-dispatcher.js";

/** 测试替身收口 —— 只填被读到的字段。 */
// biome-ignore lint/suspicious/noExplicitAny: 见上
type Any = any;

const logger = { debug() {}, info() {}, warn() {}, error() {} } as Any;

const MASTER = "10001";
const STRANGER = "20002";

/** `null` = 主人私聊 user_id 没配上(不能用 undefined:默认参数会把它换成 MASTER)。 */
function makeDispatcher(
	commands: {
		name: string;
		aliases?: string[];
		signature?: string;
		run: (values: Any) => Promise<void>;
	}[],
	master: string | null = MASTER,
	prefix = "/",
	confirmation?: Any,
) {
	const reply = vi.fn(async () => {});
	const dispatcher = createCommandDispatcher({
		logger,
		masterUserId: () => master ?? undefined,
		reply: reply as Any,
		prefix,
		commands,
		confirmation,
	});
	return { dispatcher, reply };
}

describe("鉴权门", () => {
	it("不是主人:handler 不跑,而且一个字都不回", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run }]);

		await dispatcher.handleMessage({ userId: STRANGER, text: "状态" });

		expect(run).not.toHaveBeenCalled();
		// 回「你没权限」等于告诉对方这里有个接口可以试探。
		expect(reply).not.toHaveBeenCalled();
	});
});

describe("路由", () => {
	it("主人发已知指令 → 交给对应 handler", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "状态", run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" });

		expect(run).toHaveBeenCalledOnce();
	});
});

describe("参数", () => {
	it("按签名解析后再交给 handler —— handler 拿到的是已校验的值,不是原始文本", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "静音", signature: "<时长:duration>", run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/静音 3h" });

		expect(run).toHaveBeenCalledWith({ 时长: 3 * 3600_000 });
	});

	it("参数不合法 → 告诉主人哪里错了,而且**不进** handler", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([
			{ name: "静音", signature: "<时长:duration>", run },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/静音 一会儿" });

		expect(run).not.toHaveBeenCalled();
		expect(reply).toHaveBeenCalledWith(expect.stringContaining("时长"));
	});
});

describe("前缀闸", () => {
	it("主人说别的话:不当指令,也不拿「无此指令」去打扰他", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "今天天气不错" });

		expect(run).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});

	// 带了前缀 = 意图明确,这时才敢回「没这条指令」。不带前缀的话同一套逻辑会对主人
	// 的**每一句聊天**都回这句。
	it("带前缀但没这条指令 → 提示主人", async () => {
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run: async () => {} }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/不存在" });

		expect(reply).toHaveBeenCalled();
	});

	// 强制联动:前缀配成空,就必须退化成「认不出当没看见」。这两件事得在代码里绑死,
	// 不能只在 UI 上写行提示指望主人自己想明白 —— 他配出一个会打扰自己的组合,
	// 是我们的设计错误,不是他的操作错误。
	it("前缀为空时,认不出的输入必须静默", async () => {
		const { dispatcher, reply } = makeDispatcher(
			[{ name: "状态", run: async () => {} }],
			MASTER,
			"",
		);

		await dispatcher.handleMessage({ userId: MASTER, text: "今天天气不错" });

		expect(reply).not.toHaveBeenCalled();
	});

	it("前缀为空时,整句精确匹配仍然有效", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "状态", run }], MASTER, "");

		await dispatcher.handleMessage({ userId: MASTER, text: "状态" });

		expect(run).toHaveBeenCalledOnce();
	});
});

describe("零回音(鉴权在解析之前)", () => {
	it("主人私聊目标没配:谁都不认,也不回", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run }], null);

		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" });

		expect(run).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});

	// 这条最能说明顺序的意义:同样是「未知指令」,主人会收到提示,陌生人一个字都收不到。
	// 鉴权若写成路由里的中间件,这句提示就会先漏出去。
	it("陌生人发未知指令:同样零回音", async () => {
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run: async () => {} }]);

		await dispatcher.handleMessage({ userId: STRANGER, text: "/不存在" });

		expect(reply).not.toHaveBeenCalled();
	});

	it("陌生人发合法指令带合法参数:照样不执行、不回音", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([
			{ name: "静音", signature: "<时长:duration>", run },
		]);

		await dispatcher.handleMessage({ userId: STRANGER, text: "/静音 3h" });

		expect(run).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});
});

describe("健壮性", () => {
	it("整句必须只有指令 —— 「看看状态吧」不触发", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "状态", run }], MASTER, "");

		await dispatcher.handleMessage({ userId: MASTER, text: "看看状态吧" });

		expect(run).not.toHaveBeenCalled();
	});

	it("handler 抛错不该把这条入站链路带塌 —— 它还担着审批的 y/n", async () => {
		const boom = vi.fn(async () => {
			throw new Error("boom");
		});
		const { dispatcher } = makeDispatcher([{ name: "状态", run: boom }]);

		await expect(
			dispatcher.handleMessage({ userId: MASTER, text: "/状态" }),
		).resolves.toBeUndefined();
		expect(boom).toHaveBeenCalledOnce();
	});

	it("群消息一律不认 —— 群里有人打个「/状态」不该触发", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run }]);

		await dispatcher.handle({
			post_type: "message",
			message_type: "group",
			group_id: 123,
			user_id: MASTER,
			raw_message: "/状态",
		});

		expect(run).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});

	it("OneBot 私聊帧走得通 —— handle 只是 handleMessage 的解析前置", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "状态", run }]);

		await dispatcher.handle({
			post_type: "message",
			message_type: "private",
			user_id: MASTER,
			raw_message: "/状态",
		});

		expect(run).toHaveBeenCalledOnce();
	});
});

describe("确认流窗口(第二道门)", () => {
	/** 待确认队列的替身。dispatcher 不知道 y/n 这个语法,只问「消费了吗」。 */
	function makeConfirmation(waiting: boolean) {
		return {
			isWaiting: () => waiting,
			tryHandle: vi.fn(async (msg: { text: string }) => /^(y|n)$/i.test(msg.text.trim())),
		};
	}

	it("有待确认项时,y 交给确认流,不进指令表", async () => {
		const run = vi.fn(async () => {});
		const confirmation = makeConfirmation(true);
		const { dispatcher } = makeDispatcher([{ name: "y", run }], MASTER, "", confirmation);

		await dispatcher.handleMessage({ userId: MASTER, text: "y" });

		expect(confirmation.tryHandle).toHaveBeenCalledOnce();
		expect(run).not.toHaveBeenCalled();
	});

	// 这是收编时顺带修掉的一个毛病:以前无条件解析 y/n,主人在私聊里随口打个 y
	// (英文聊天里很常见)就会收到「现在没有等待审批的锐评哦～」。草稿 TTL 有 48 小时,
	// 真要批准几乎不可能撞上超时;没待审时那个 y 就只是个普通字母。
	it("没有待确认项时,压根不问确认流 —— y 只是个普通字母", async () => {
		const confirmation = makeConfirmation(false);
		const { dispatcher, reply } = makeDispatcher(
			[{ name: "状态", run: async () => {} }],
			MASTER,
			"/",
			confirmation,
		);

		await dispatcher.handleMessage({ userId: MASTER, text: "y" });

		expect(confirmation.tryHandle).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});

	it("确认流不认的输入继续往下走指令表", async () => {
		const run = vi.fn(async () => {});
		const confirmation = makeConfirmation(true);
		const { dispatcher } = makeDispatcher([{ name: "状态", run }], MASTER, "/", confirmation);

		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" });

		expect(confirmation.tryHandle).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledOnce();
	});

	it("确认流也在鉴权门之后 —— 陌生人的 y 碰不到它", async () => {
		const confirmation = makeConfirmation(true);
		const { dispatcher } = makeDispatcher([], MASTER, "/", confirmation);

		await dispatcher.handleMessage({ userId: STRANGER, text: "y" });

		expect(confirmation.tryHandle).not.toHaveBeenCalled();
	});
});

describe("别名", () => {
	it("别名能触发,和主名等价", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "help", aliases: ["帮助", "?"], run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/帮助" });
		await dispatcher.handleMessage({ userId: MASTER, text: "/?" });
		await dispatcher.handleMessage({ userId: MASTER, text: "/help" });

		expect(run).toHaveBeenCalledTimes(3);
	});

	// koishi 专门修过这个回归(`fix regression of command alias args`)—— 别名匹配
	// 只剥掉主名的长度,参数就跟着错位。它的别名还是硬编码的,我们的还让主人自己配。
	it("别名带参数 —— 参数不能因为别名长度不同而错位", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([
			{ name: "mute", aliases: ["静音"], signature: "<duration:duration|时长>", run },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/静音 3h" });

		expect(run).toHaveBeenCalledWith({ duration: 3 * 3600_000 });
	});

	it("没配别名的指令照常工作", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "status", run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/status" });

		expect(run).toHaveBeenCalledOnce();
	});

	it("边界仍然要守 —— 「/静音吧」不该命中别名「静音」", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "mute", aliases: ["静音"], run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/静音吧" });

		expect(run).not.toHaveBeenCalled();
	});
});

/**
 * 触发词冲突 —— 两条指令抢同一个词,只有一条会响,而且是**静默**的。
 *
 * 方案里点名过这个:主人给「周报」起了个别名叫「状态」,运行时二选一,他看到的是
 * 某条指令神秘失灵。别名将来是面板上可配的,所以这道判定迟早要被真实用户踩到 ——
 * 在注册那一刻就炸,比让他自己去猜哪条坏了强得多。
 */
describe("createCommandDispatcher — 触发词冲突", () => {
	const noop = async () => {};

	it("两条指令主名撞了 → 注册时就抛", () => {
		expect(() =>
			makeDispatcher([
				{ name: "report", run: noop },
				{ name: "report", run: noop },
			]),
		).toThrow(/report/);
	});

	it("别名撞了别的指令的主名 → 一样抛", () => {
		expect(() =>
			makeDispatcher([
				{ name: "status", run: noop },
				{ name: "report", aliases: ["status"], run: noop },
			]),
		).toThrow(/status/);
	});

	it("两条指令共用一个别名 → 一样抛", () => {
		expect(() =>
			makeDispatcher([
				{ name: "status", aliases: ["看看"], run: noop },
				{ name: "report", aliases: ["看看"], run: noop },
			]),
		).toThrow(/看看/);
	});

	it("互不相干的指令照常注册", () => {
		expect(() =>
			makeDispatcher([
				{ name: "status", aliases: ["状态"], run: noop },
				{ name: "report", aliases: ["周报"], run: noop },
			]),
		).not.toThrow();
	});
});
