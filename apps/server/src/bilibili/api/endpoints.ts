export const USER_SPACE_DYNAMIC_URL =
	"https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?platform=web&features=itemOpusStyle";
export const ALL_DYNAMIC_URL =
	"https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?platform=web&features=itemOpusStyle";
export const COOKIE_INFO_URL = "https://passport.bilibili.com/x/passport-login/web/cookie/info";
export const USER_INFO_URL = "https://api.bilibili.com/x/space/wbi/acc/info";
export const MYSELF_INFO_URL = "https://api.bilibili.com/x/member/web/account";
export const LOGIN_QR_CODE_URL =
	"https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
export const LOGIN_STATUS_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
export const LIVE_ROOM_INFO_URL = "https://api.live.bilibili.com/room/v1/Room/get_info";
export const MASTER_INFO_URL = "https://api.live.bilibili.com/live_user/v1/Master/info";
export const USER_CARD_URL = "https://api.bilibili.com/x/web-interface/card";
/** 关系状态数(粉丝/关注)。轻量,专用于粉丝计数轮询(比 card 载荷小得多)。 */
export const RELATION_STAT_URL = "https://api.bilibili.com/x/relation/stat";
/** 多用户详细信息(name/face/vip),uids 逗号分隔、单次最多 50 个。 */
export const USER_CARDS_URL = "https://api.bilibili.com/x/polymer/pc-electron/v1/user/cards";
export const USER_INFO_IN_LIVE_URL = "https://api.live.bilibili.com/xlive/app-ucenter/v2/card/user";
export const RELATION_MODIFY_URL = "https://api.bilibili.com/x/relation/modify";
/**
 * 批量查询与多个用户的关系,`fids` 逗号分隔。用来在启动时一次问清「哪些订阅还没关注」,
 * 免得对每个订阅都盲发一次 follow(写接口的风控比读严得多)。
 */
export const RELATIONS_URL = "https://api.bilibili.com/x/relation/relations";
export const LIVE_ROOM_INFO_STREAM_KEY_URL =
	"https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo";
export const LIVE_ROOMS_INFO_URL =
	"https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids";
export const TICKET_URL =
	"https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket";
export const COOKIE_REFRESH_CORRESPOND_PATH = "https://www.bilibili.com/correspond/1";
export const COOKIE_REFRESH_URL =
	"https://passport.bilibili.com/x/passport-login/web/cookie/refresh";
export const COOKIE_REFRESH_CONFIRM_URL =
	"https://passport.bilibili.com/x/passport-login/web/confirm/refresh";
export const USER_UPSTAT_URL = "https://api.bilibili.com/x/space/upstat";
export const USER_NAVNUM_URL = "https://api.bilibili.com/x/space/navnum";
export const USER_VIDEOS_URL = "https://api.bilibili.com/x/space/wbi/arc/search";
export const SEARCH_BY_TYPE_URL = "https://api.bilibili.com/x/web-interface/wbi/search/type";
export const FINGER_SPI_URL = "https://api.bilibili.com/x/frontend/finger/spi";
/** 单个视频的信息(标题 / 封面 / UP / 播放弹幕等),按 bvid 或 aid 取。链接解析用。 */
export const VIDEO_INFO_URL = "https://api.bilibili.com/x/web-interface/view";
