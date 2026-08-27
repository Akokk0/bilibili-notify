export {
	connectLiveRoom,
	type DanmuHost,
	type LiveClient,
	type LiveConnectOptions,
	type SocketLike,
} from "./client.js";
export {
	type FanBadge,
	GuardLevel,
	type LiveEvent,
	type LiveUser,
	type UserActionType,
} from "./events.js";
// 供消费方在 raw 之上自建解析时复用(如需对未收录命令做同款容错映射);
// PARSED_COMMANDS 是已知命令集合,配合 raw 事件的 degraded 标志做漂移观测
export { PARSED_COMMANDS, parseCommand } from "./parser.js";
