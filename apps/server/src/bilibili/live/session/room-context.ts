import type { Logger, Result, ServiceContext, SourceContext } from "@bilibili-notify/internal";
import type {
	LiveRoomDanmakuResponse,
	LiveRoomResponse,
	MyselfResponse,
	UserInfoResponse,
} from "../../api/index.js";
import type { ProblemLayers } from "../../problem-layers.js";
import { connectLiveRoom, type DanmakuHost } from "../protocol/client.js";
import type { LiveEvent } from "../protocol/events.js";
import type { RoomIds } from "../room-ids.js";
import {
	describeLiveRoomDanmakuAccessDenied,
	LiveRoomAccessDeniedError,
	LiveRoomPreflightBlockedError,
	reasonOfFailure,
} from "./room-helpers.js";

type LiveRoomDanmaku = LiveRoomDanmakuResponse["data"];

export type LiveProblems = Pick<
	ProblemLayers,
	"reportRisk" | "resolveRisk" | "reportFailure" | "resolveFailure"
>;

export const MONITOR_STOPPED_CODE = "live_monitor_stopped";
export const ROOM_RESTRICTED_CODE = "live_room_restricted";
export const LIVE_ROOM_NOT_FOUND_CODE = "live_room_not_found";

export const liveRiskPath = (externalId: string): string => `live:${externalId}`;

export interface RoomContextOptions {
	api: {
		fetchLiveRoomInfo(roomId: string): Promise<LiveRoomResponse>;
		fetchLiveRoomInfoStreamKey(roomId: string): Promise<Result<{ data: LiveRoomDanmaku }>>;
		fetchUserInfo(externalId: string): Promise<Result<{ data: UserInfoResponse["data"] }>>;
		getMasterInfo(externalId: string): Promise<unknown>;
		getMyselfInfoCached(): Promise<MyselfResponse>;
		getBuvid3(): Promise<string>;
		openDanmakuSocket(url: string): unknown;
	};
	liveContext: ServiceContext;
	source: SourceContext;
	problems: LiveProblems;
	roomIds: RoomIds;
	rememberFanClubName(externalId: string, name: string): void;
	rememberSuperchatAvatar(viewerId: string, url: string): void;
}

export class RoomContext {
	readonly api: RoomContextOptions["api"];
	readonly logger: Logger;
	readonly source: SourceContext;
	readonly problems: LiveProblems;
	readonly liveContext: ServiceContext;
	readonly roomIds: RoomIds;
	readonly rememberFanClubName: RoomContextOptions["rememberFanClubName"];
	readonly rememberSuperchatAvatar: RoomContextOptions["rememberSuperchatAvatar"];
	readonly listenerRecord: Record<string, { close(): void; closed: boolean }> = {};

	private disposed = false;
	private readonly instanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	private readonly hostRotation = new Map<string, number>();

	constructor(opts: RoomContextOptions) {
		this.api = opts.api;
		this.liveContext = opts.liveContext;
		this.logger = opts.liveContext.logger;
		this.source = opts.source;
		this.problems = opts.problems;
		this.roomIds = opts.roomIds;
		this.rememberFanClubName = opts.rememberFanClubName;
		this.rememberSuperchatAvatar = opts.rememberSuperchatAvatar;
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	dispose(): void {
		this.disposed = true;
		this.clearListeners();
	}

	async startLiveRoomListener(
		roomId: string,
		onEvent: (event: LiveEvent) => void | Promise<void>,
		shouldAbort?: () => boolean,
	): Promise<boolean> {
		const aborted = () => this.isDisposed() || shouldAbort?.() === true;
		if (aborted()) return false;
		const roomIdNumber = Number.parseInt(roomId, 10);
		if (!Number.isFinite(roomIdNumber) || roomIdNumber <= 0) {
			this.logger.error(
				`[conn] roomId 非法（"${roomId}"），跳过 listener 创建。请检查订阅配置或用户是否开通直播间`,
			);
			return false;
		}
		if (this.listenerRecord[roomId]) {
			this.logger.warn(`[conn] 直播间 [${roomId}] 连接已存在，跳过创建`);
			return true;
		}

		let preflight: Result<{ data: LiveRoomDanmaku }>;
		try {
			preflight = await this.api.fetchLiveRoomInfoStreamKey(roomId);
		} catch (error) {
			this.logger.warn(`[conn] 获取弹幕连接信息异常，房间 [${roomId}]：${String(error)}`);
			return false;
		}
		if (!preflight.ok) {
			switch (preflight.code) {
				case "rate_limited":
					throw new LiveRoomPreflightBlockedError(reasonOfFailure(preflight));
				case "unauthorized":
				case "unavailable":
					this.logger.warn(
						`[conn] 预检没拿到连接信息，房间 [${roomId}]：${reasonOfFailure(preflight)}`,
					);
					return false;
				default:
					throw new LiveRoomAccessDeniedError(reasonOfFailure(preflight));
			}
		}
		const info = preflight.data;
		const denied = describeLiveRoomDanmakuAccessDenied(info);
		if (denied) throw new LiveRoomAccessDeniedError(denied);
		const token = typeof info?.token === "string" ? info.token.trim() : "";
		const hostList: DanmakuHost[] = [];
		for (const entry of Array.isArray(info?.host_list) ? info.host_list : []) {
			const host = entry as { host?: unknown; wss_port?: unknown };
			if (typeof host.host === "string" && host.host && typeof host.wss_port === "number") {
				hostList.push({ host: host.host, wssPort: host.wss_port });
			}
		}
		if (!token || hostList.length === 0) {
			this.logger.warn(`[conn] 直播间 [${roomId}] 弹幕连接信息不完整,视为本轮失败`);
			return false;
		}

		let self: MyselfResponse;
		try {
			self = await this.api.getMyselfInfoCached();
		} catch (error) {
			this.logger.warn(`[conn] 获取个人信息异常，房间 [${roomId}]：${String(error)}`);
			return false;
		}
		if (self.code !== 0 || !self.data) {
			this.logger.warn(
				`[conn] 获取个人信息失败 code=${self.code}，无法创建直播间 [${roomId}] 连接`,
			);
			return false;
		}
		const buvid = await this.api.getBuvid3();
		if (aborted()) return false;

		const attempt = this.hostRotation.get(roomId) ?? 0;
		this.hostRotation.set(roomId, attempt + 1);
		const offset = attempt % hostList.length;
		const rotated = [...hostList.slice(offset), ...hostList.slice(0, offset)];
		const listener = connectLiveRoom({
			roomId: roomIdNumber,
			uid: self.data.mid,
			token,
			buvid,
			hostList: rotated,
			createSocket: (url) => this.api.openDanmakuSocket(url) as never,
			onEvent,
		});
		if (aborted()) {
			listener.close();
			return false;
		}
		this.listenerRecord[roomId] = listener;
		this.logger.info(`[conn] 直播间 [${roomId}] 连接已建立`);
		this.logSideEffectState(`listener:created room=${roomId}`);
		return true;
	}

	async fetchRoomInfo(roomId: string): Promise<LiveRoomResponse["data"] | undefined> {
		try {
			const response = await this.api.fetchLiveRoomInfo(roomId);
			return response.data;
		} catch (error) {
			this.logger.error(`[conn] 获取直播间信息失败：${String(error)}`);
			return undefined;
		}
	}

	async fetchMasterSnapshot(externalId: string): Promise<{ name?: string; fanClubName?: string }> {
		try {
			const response = (await this.api.getMasterInfo(externalId)) as {
				data?: { medal_name?: unknown; info?: { uname?: unknown } };
			};
			const fanClubName =
				typeof response.data?.medal_name === "string" ? response.data.medal_name : undefined;
			if (fanClubName) this.rememberFanClubName(externalId, fanClubName);
			return {
				...(typeof response.data?.info?.uname === "string"
					? { name: response.data.info.uname }
					: {}),
				...(fanClubName === undefined ? {} : { fanClubName }),
			};
		} catch (error) {
			this.logger.warn(
				`[live] 直播间 [${this.roomIds.get(externalId) ?? ""}] 取粉丝牌名失败：${String(error)}`,
			);
			return {};
		}
	}

	closeListener(roomId: string): void {
		const listener = this.listenerRecord[roomId];
		if (!listener) {
			this.logger.debug(`[conn] 直播间 [${roomId}] 连接不存在，跳过关闭`);
			return;
		}
		if (listener.closed) {
			this.logger.debug(`[conn] 直播间 [${roomId}] 连接已结束,跳过关闭`);
			delete this.listenerRecord[roomId];
			return;
		}
		listener.close();
		delete this.listenerRecord[roomId];
		this.logger.info(`[conn] 直播间 [${roomId}] 连接已关闭`);
		this.logSideEffectState(`listener:closed room=${roomId}`);
	}

	clearListeners(): void {
		this.logSideEffectState("listeners:before-clear");
		for (const roomId of Object.keys(this.listenerRecord)) this.closeListener(roomId);
		this.logSideEffectState("listeners:after-clear");
	}

	private logSideEffectState(stage: string): void {
		this.logger.debug(
			`[conn] [live:${this.instanceId}] ${stage} listeners=${Object.keys(this.listenerRecord).length} disposed=${this.disposed}`,
		);
	}
}
