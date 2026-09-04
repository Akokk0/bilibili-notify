#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::Serialize;
use std::{
    env,
    ffi::{OsStr, OsString},
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, Manager, RunEvent, State, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const HOST: &str = "127.0.0.1";
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_INTERVAL: Duration = Duration::from_millis(350);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);
const DESKTOP_TOKEN_QUERY: &str = "desktopToken";

#[derive(Default)]
struct LauncherState {
    inner: Mutex<LauncherInner>,
}

struct LauncherInner {
    status: LauncherStatus,
    message: String,
    detail: Option<String>,
    panel_url: Option<String>,
    paths: Option<LauncherPaths>,
    service: Option<ServiceProcess>,
    quitting: bool,
    dock_hidden: bool,
    tray_ready: bool,
}

impl Default for LauncherInner {
    fn default() -> Self {
        Self {
            status: LauncherStatus::Stopped,
            message: "正在初始化桌面壳。".to_string(),
            detail: None,
            panel_url: None,
            paths: None,
            service: None,
            quitting: false,
            dock_hidden: false,
            tray_ready: false,
        }
    }
}

#[derive(Clone)]
struct LauncherPaths {
    data_dir: PathBuf,
    server_log_dir: PathBuf,
    launcher_log_dir: PathBuf,
    settings_file: PathBuf,
}

struct ServiceProcess {
    child: Child,
    pid: u32,
    port: u16,
    url: String,
}

#[derive(Clone, PartialEq)]
enum LauncherStatus {
    Starting,
    Ready,
    Stopped,
    Failed,
    Crashed,
}

impl LauncherStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
            Self::Crashed => "crashed",
        }
    }

    fn label(&self) -> &'static str {
        match self {
            Self::Starting => "正在启动后端服务",
            Self::Ready => "后端服务已就绪",
            Self::Stopped => "后端服务已停止",
            Self::Failed => "后端服务启动失败",
            Self::Crashed => "后端服务已崩溃",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherStateView {
    status: String,
    status_label: String,
    message: String,
    detail: Option<String>,
    panel_url: Option<String>,
    data_dir: Option<String>,
    server_log_dir: Option<String>,
    launcher_log_dir: Option<String>,
    dock_hidden: bool,
    dock_toggle_available: bool,
}

struct ResourcePaths {
    root: PathBuf,
    node: PathBuf,
    server_dir: PathBuf,
    server_entry: PathBuf,
    web_dist: PathBuf,
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .manage(LauncherState::default())
        .invoke_handler(tauri::generate_handler![
            get_launcher_state,
            retry_service,
            open_launcher_log_dir,
            open_data_dir,
            open_server_log_dir,
            open_panel_in_browser,
            toggle_dock_icon,
            quit_app
        ])
        .setup(|app| {
            setup_launcher(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<LauncherState>();
                let quitting = state
                    .inner
                    .lock()
                    .map(|inner| inner.quitting)
                    .unwrap_or(true);
                if !quitting {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building bilibili-notify desktop");

    app.run(handle_run_event);
}

fn handle_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { code, .. } => {
            let reason = exit_requested_reason(code);
            prepare_for_exit(app, &reason);
        }
        RunEvent::Exit => prepare_for_exit(app, "event loop exit"),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Ok(paths) = current_paths(app) {
                append_launcher_log(&paths.launcher_log_dir, "dock reopen");
            }
            show_main_window(app);
        }
        _ => {}
    }
}

fn exit_requested_reason(code: Option<i32>) -> String {
    match code {
        Some(code) => format!("programmatic exit code={code}"),
        None => "system exit".to_string(),
    }
}

fn setup_launcher(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let paths = create_launcher_paths()?;
    let dock_hidden = load_dock_hidden(&paths.settings_file);
    {
        let state = app.state::<LauncherState>();
        let mut inner = state.inner.lock().expect("launcher state poisoned");
        inner.paths = Some(paths.clone());
        inner.dock_hidden = dock_hidden;
    }
    append_launcher_log(&paths.launcher_log_dir, "launcher setup");
    setup_main_window(app)?;
    setup_menu(app)?;
    let tray_ready = match setup_tray(app) {
        Ok(()) => {
            append_launcher_log(&paths.launcher_log_dir, "tray ready");
            true
        }
        Err(err) => {
            append_launcher_log(
                &paths.launcher_log_dir,
                &format!("setup tray failed: {err}"),
            );
            false
        }
    };
    {
        let state = app.state::<LauncherState>();
        let mut inner = state.inner.lock().expect("launcher state poisoned");
        inner.tray_ready = tray_ready;
    }
    if dock_hidden && tray_ready {
        let _ = set_dock_visible(app.handle(), false);
    } else if dock_hidden {
        let state = app.state::<LauncherState>();
        if let Ok(mut inner) = state.inner.lock() {
            inner.dock_hidden = false;
        }
        let _ = save_dock_hidden(&paths.settings_file, false);
    }
    start_service_async(app.handle().clone());
    Ok(())
}

/// 主窗口程序化建窗(不放 tauri.conf 的 windows 配)—— 为了挂 `on_navigation`。
/// dashboard 从本机 server 加载,点外链(爱发电等)走同窗口导航,这里拦截外部
/// http(s) 交系统浏览器并取消 webview 内导航(否则 Tauri webview 要么对
/// `target="_blank"` 没反应,要么会把 dashboard 替换成外部站)。
fn setup_main_window(app: &App) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Bilibili Notify")
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 640.0)
        .visible(true)
        .on_navigation(handle_navigation)
        // 关闭 webview 的 OS 级拖放接管 —— 否则 dashboard 里卡片版式的 HTML5 拖拽
        // 重排会被系统文件拖放劫持而完全失效(用户报告的「桌面端拖不动」)。本应用
        // 不靠 OS 文件拖放,资源上传走文件选择,关闭无副作用。
        .disable_drag_drop_handler()
        .build()?;
    Ok(())
}

/// `on_navigation` 回调:返回 `true` 放行、`false` 取消本次 webview 内导航。
/// 内部协议(tauri:// 等)与本机 dashboard/splash(127.0.0.1 / localhost)放行;
/// 其余外部 http(s) 交系统浏览器并取消(链接在系统默认浏览器打开,dashboard 不动)。
fn handle_navigation(url: &Url) -> bool {
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return true;
    }
    let host = url.host_str().unwrap_or("");
    if matches!(host, "127.0.0.1" | "localhost" | "tauri.localhost") {
        return true;
    }
    let _ = open_url_with_system(url.as_str());
    false
}

fn setup_menu(app: &mut App) -> tauri::Result<()> {
    // macOS:菜单统一在系统顶栏,必须给原生 App / 编辑 / 窗口菜单(否则复制粘贴、
    // 关于、退出等系统项全无)。启动器动作收进「操作」子菜单(托盘里也有一份)。
    #[cfg(target_os = "macos")]
    {
        let menu = build_macos_menu(app)?;
        app.set_menu(menu)?;
    }
    // Windows:菜单会渲染成应用内顶部菜单栏(很丑),不设;动作走托盘。
    // Linux:沿用扁平启动器菜单。
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let menu = build_launcher_menu(app)?;
        app.set_menu(menu)?;
    }
    app.on_menu_event(|app, event| handle_launcher_menu_event(app, event.id().as_ref()));
    Ok(())
}

/// 菜单自定义文案是否用简体中文 —— 跟随系统语言:简体中文系统(zh-Hans / zh-CN /
/// zh-SG / 裸 zh)用中文,繁体(zh-Hant / TW / HK / MO)与其余语言一律英文。系统
/// 预定义项(复制/粘贴/退出等)由 OS 按系统语言自行本地化,这里只管自定义项,与之对齐。
fn menu_use_zh() -> bool {
    let locale = sys_locale::get_locale().unwrap_or_default().to_lowercase();
    if !locale.starts_with("zh") {
        return false;
    }
    // 已限定 zh-* 前缀,内部区域码判繁体即可(hant/tw/hk/mo),其余视为简体。
    !(locale.contains("hant")
        || locale.contains("tw")
        || locale.contains("hk")
        || locale.contains("mo"))
}

/// 按 `zh` 选中文/英文文案。
fn t(zh: bool, zh_text: &'static str, en_text: &'static str) -> &'static str {
    if zh {
        zh_text
    } else {
        en_text
    }
}

/// 启动器的 7 条自定义动作项 —— 托盘菜单与 macOS「Actions」子菜单共用,文案按
/// 系统语言。id 与 `handle_launcher_menu_event` 的 case 一一对应。
fn build_action_menu_items(app: &App, zh: bool) -> tauri::Result<Vec<MenuItem<tauri::Wry>>> {
    Ok(vec![
        MenuItem::with_id(
            app,
            "show_window",
            t(zh, "显示/隐藏窗口", "Show/Hide Window"),
            true,
            None::<&str>,
        )?,
        MenuItem::with_id(
            app,
            "open_panel",
            t(zh, "用浏览器打开面板", "Open Panel in Browser"),
            true,
            None::<&str>,
        )?,
        MenuItem::with_id(
            app,
            "restart_service",
            t(zh, "重启服务", "Restart Service"),
            true,
            None::<&str>,
        )?,
        MenuItem::with_id(
            app,
            "open_data_dir",
            t(zh, "打开数据目录", "Open Data Folder"),
            true,
            None::<&str>,
        )?,
        MenuItem::with_id(
            app,
            "open_server_log_dir",
            t(zh, "打开后端日志目录", "Open Server Logs"),
            true,
            None::<&str>,
        )?,
        MenuItem::with_id(
            app,
            "open_launcher_log_dir",
            t(zh, "打开启动器日志目录", "Open Launcher Logs"),
            true,
            None::<&str>,
        )?,
        MenuItem::with_id(
            app,
            "toggle_dock",
            t(zh, "隐藏/显示 Dock 图标", "Hide/Show Dock Icon"),
            true,
            None::<&str>,
        )?,
    ])
}

/// macOS 原生菜单:App(关于/隐藏/退出)+ 编辑(撤销/剪切/复制/粘贴/全选)+
/// 窗口 + 启动器「操作」子菜单。预定义项由系统直接处理,不经 `on_menu_event`。
#[cfg(target_os = "macos")]
fn build_macos_menu(app: &App) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::{PredefinedMenuItem, Submenu};

    let zh = menu_use_zh();
    // About 不走系统标准 About 面板,而是跳应用内「关于」页(dashboard /about),与多数
    // 桌面软件一致。故用自定义 id 的 MenuItem,经 on_menu_event → open_about_page 处理。
    let about = MenuItem::with_id(
        app,
        "show_about",
        t(
            zh,
            "关于 Bilibili Notify Desktop",
            "About Bilibili Notify Desktop",
        ),
        true,
        None::<&str>,
    )?;
    let app_menu = Submenu::with_items(
        app,
        "Bilibili Notify",
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        t(zh, "编辑", "Edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        t(zh, "窗口", "Window"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let actions = build_macos_actions_submenu(app)?;
    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu, &actions])
}

/// macOS 顶栏的「操作 / Actions」子菜单 —— 复用 `build_action_menu_items`(经
/// `on_menu_event` 派发)。退出已由 App 菜单的原生 Quit 覆盖,这里不再重复。
#[cfg(target_os = "macos")]
fn build_macos_actions_submenu(app: &App) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    use tauri::menu::{IsMenuItem, Submenu};

    let zh = menu_use_zh();
    let items = build_action_menu_items(app, zh)?;
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items
        .iter()
        .map(|i| i as &dyn IsMenuItem<tauri::Wry>)
        .collect();
    Submenu::with_items(app, t(zh, "操作", "Actions"), true, &refs)
}

fn setup_tray(app: &mut App) -> tauri::Result<()> {
    let menu = build_launcher_menu(app)?;
    let mut builder = TrayIconBuilder::with_id("bilibili-notify")
        .menu(&menu)
        .tooltip("Bilibili Notify")
        .show_menu_on_left_click(true);
    #[cfg(target_os = "macos")]
    {
        if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-logo.png"))
        {
            builder = builder.icon(icon).icon_as_template(true);
        } else if let Some(icon) = app.default_window_icon().cloned() {
            builder = builder.icon(icon).icon_as_template(false);
        } else {
            builder = builder.title("BN");
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(icon) =
            tauri::image::Image::from_bytes(include_bytes!("../icons/tray-logo-windows.png"))
        {
            builder = builder.icon(icon).icon_as_template(false);
        } else if let Some(icon) = app.default_window_icon().cloned() {
            builder = builder.icon(icon).icon_as_template(false);
        } else {
            builder = builder.title("BN");
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(icon) = app.default_window_icon().cloned() {
            builder = builder.icon(icon).icon_as_template(false);
        } else {
            builder = builder.title("BN");
        }
    }
    builder.build(app)?;
    Ok(())
}

fn build_launcher_menu(app: &App) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::IsMenuItem;

    let zh = menu_use_zh();
    let items = build_action_menu_items(app, zh)?;
    let quit = MenuItem::with_id(
        app,
        "quit_app",
        t(zh, "退出应用", "Quit"),
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let mut refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items
        .iter()
        .map(|i| i as &dyn IsMenuItem<tauri::Wry>)
        .collect();
    refs.push(&quit);
    Menu::with_items(app, &refs)
}

fn handle_launcher_menu_event(app: &AppHandle, id: &str) {
    match id {
        "show_about" => open_about_page(app),
        "show_window" => toggle_main_window(app),
        "open_panel" => open_panel(app),
        "restart_service" => start_service_async(app.clone()),
        "open_data_dir" => open_known_path(app, KnownPath::Data),
        "open_server_log_dir" => open_known_path(app, KnownPath::ServerLogs),
        "open_launcher_log_dir" => open_known_path(app, KnownPath::LauncherLogs),
        "toggle_dock" => toggle_dock(app),
        "quit_app" => request_quit(app.clone()),
        _ => {}
    }
}

/// 菜单栏「About」→ 跳应用内「关于」页(dashboard `/about`),而非系统 About 面板。
/// 在已就绪的 panel_url 上把路径换成 `/about`、保留 `#desktopToken` 片段(鉴权照常),
/// 导航主窗口过去。dashboard 尚未就绪时静默 no-op(此时点 About 罕见)。
fn open_about_page(app: &AppHandle) {
    let panel = {
        let state = app.state::<LauncherState>();
        let inner = state.inner.lock().expect("launcher state poisoned");
        inner.panel_url.clone()
    };
    let Some(panel) = panel else { return };
    if let Ok(mut url) = Url::parse(&panel) {
        url.set_path("/about");
        navigate_main_window(app, url.as_str());
    }
}

#[tauri::command]
fn get_launcher_state(state: State<'_, LauncherState>) -> LauncherStateView {
    let inner = state.inner.lock().expect("launcher state poisoned");
    LauncherStateView {
        status: inner.status.as_str().to_string(),
        status_label: inner.status.label().to_string(),
        message: inner.message.clone(),
        detail: inner.detail.clone(),
        panel_url: inner.panel_url.clone(),
        data_dir: inner
            .paths
            .as_ref()
            .map(|p| p.data_dir.display().to_string()),
        server_log_dir: inner
            .paths
            .as_ref()
            .map(|p| p.server_log_dir.display().to_string()),
        launcher_log_dir: inner
            .paths
            .as_ref()
            .map(|p| p.launcher_log_dir.display().to_string()),
        dock_hidden: inner.dock_hidden,
        dock_toggle_available: dock_toggle_available(&inner),
    }
}

#[tauri::command]
fn retry_service(app: AppHandle) -> Result<(), String> {
    start_service_async(app);
    Ok(())
}

#[tauri::command]
fn open_launcher_log_dir(app: AppHandle) -> Result<(), String> {
    open_known_path_result(&app, KnownPath::LauncherLogs)
}

#[tauri::command]
fn open_data_dir(app: AppHandle) -> Result<(), String> {
    open_known_path_result(&app, KnownPath::Data)
}

#[tauri::command]
fn open_server_log_dir(app: AppHandle) -> Result<(), String> {
    open_known_path_result(&app, KnownPath::ServerLogs)
}

#[tauri::command]
fn open_panel_in_browser(app: AppHandle) -> Result<(), String> {
    open_panel_result(&app)
}

#[tauri::command]
fn toggle_dock_icon(app: AppHandle) -> Result<bool, String> {
    toggle_dock_result(&app)
}

#[tauri::command]
fn quit_app(app: AppHandle) -> Result<(), String> {
    request_quit(app);
    Ok(())
}

fn start_service_async(app: AppHandle) {
    {
        let state = app.state::<LauncherState>();
        let mut inner = state.inner.lock().expect("launcher state poisoned");
        if inner.quitting || inner.status == LauncherStatus::Starting {
            return;
        }
        inner.status = LauncherStatus::Starting;
        inner.message = "正在启动本机后端。服务就绪后会自动打开 Dashboard。".to_string();
        inner.detail = None;
        inner.panel_url = None;
    }
    thread::spawn(move || {
        if let Err(err) = restart_service_blocking(&app) {
            mark_service_failed(&app, err);
        }
    });
}

fn restart_service_blocking(app: &AppHandle) -> Result<(), String> {
    stop_existing_service(app, "restart")?;
    let paths = current_paths(app)?;
    let resources = resolve_resources(app)?;
    let sidecar_data_dir = child_process_path(&paths.data_dir);
    let port = allocate_port()?;
    let url = format!("http://{HOST}:{port}");
    let desktop_token = generate_desktop_token()?;
    let panel_url = panel_url_with_token(&url, &desktop_token);
    let browser = detect_browser_path();

    append_launcher_log(
        &paths.launcher_log_dir,
        &format!(
            "starting sidecar port={port} data_dir={} web_dist={} browser={}",
            sidecar_data_dir.display(),
            resources.web_dist.display(),
            browser
                .as_ref()
                .map(|_| "detected".to_string())
                .unwrap_or_else(|| "none".to_string())
        ),
    );

    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.launcher_log_dir.join("sidecar.stdout.log"))
        .map_err(|err| format!("open sidecar stdout log failed: {err}"))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.launcher_log_dir.join("sidecar.stderr.log"))
        .map_err(|err| format!("open sidecar stderr log failed: {err}"))?;

    let mut command = Command::new(&resources.node);
    command
        .arg(&resources.server_entry)
        .arg("--host")
        .arg(HOST)
        .arg("--port")
        .arg(port.to_string())
        .arg("--data-dir")
        .arg(&sidecar_data_dir)
        .current_dir(&resources.server_dir)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if let Some(chrome_path) = browser {
        command
            .arg("--chrome-path")
            .arg(child_process_path(&chrome_path));
    }
    apply_sidecar_env(&mut command, &desktop_token, &url, std::process::id());
    configure_sidecar_command(&mut command);

    let pid = {
        let state = app.state::<LauncherState>();
        let mut inner = state.inner.lock().expect("launcher state poisoned");
        if inner.quitting {
            return Err("应用正在退出。".to_string());
        }
        let child = command
            .spawn()
            .map_err(|err| format!("spawn Node sidecar failed: {err}"))?;
        let pid = child.id();
        inner.service = Some(ServiceProcess {
            child,
            pid,
            port,
            url: url.clone(),
        });
        inner.status = LauncherStatus::Starting;
        inner.message = format!("后端服务正在 {url} 启动。");
        inner.detail = Some(format!(
            "资源目录: {}\n数据目录: {}\n启动器日志: {}",
            resources.root.display(),
            sidecar_data_dir.display(),
            paths.launcher_log_dir.display()
        ));
        inner.panel_url = Some(panel_url.clone());
        pid
    };
    spawn_child_monitor(app.clone(), pid);

    if !wait_for_health(port, READY_TIMEOUT) {
        stop_existing_service(app, "ready timeout")?;
        return Err(format!(
            "后端服务在 {} 秒内未就绪。",
            READY_TIMEOUT.as_secs()
        ));
    }

    {
        let state = app.state::<LauncherState>();
        let mut inner = state.inner.lock().expect("launcher state poisoned");
        if inner.quitting {
            return Ok(());
        }
        inner.status = LauncherStatus::Ready;
        inner.message = format!("Dashboard 已就绪：{url}");
        inner.detail = None;
        inner.panel_url = Some(panel_url.clone());
    }
    append_launcher_log(&paths.launcher_log_dir, &format!("sidecar ready url={url}"));
    navigate_main_window(app, &panel_url);
    Ok(())
}

#[cfg(target_os = "windows")]
fn configure_sidecar_command(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn configure_sidecar_command(_command: &mut Command) {}

#[cfg(target_os = "windows")]
fn child_process_path(path: &Path) -> PathBuf {
    strip_windows_verbatim_path(path)
}

#[cfg(not(target_os = "windows"))]
fn child_process_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

#[cfg(any(target_os = "windows", test))]
fn strip_windows_verbatim_path(path: &Path) -> PathBuf {
    let value = path.as_os_str().to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

#[derive(Debug, PartialEq, Eq)]
enum SidecarExit {
    /// 外壳自己在退出,子进程跟着走,不用管。
    Quitting,
    /// 服务端**自己要求**重启:应用更新 / 回退时它优雅停机并退 0,等着被拉起来。
    Restart,
    /// 其余一律是崩溃。
    Crashed,
}

/// 容器里有 `restart:` 策略把退出的服务端拉起来;桌面版没有进程管理器,外壳就得当那个
/// 策略 —— 否则用户在面板里按「立即重启并应用」,看到的是一张「后端服务已退出」的崩溃页。
/// 退出码 0 是服务端约定的「我是故意退的」(见 apps/server/src/index.ts 的 applyUpdate),
/// 被信号杀掉(Unix 上 code 是 None)或非 0 才是崩溃。
fn sidecar_exit_disposition(quitting: bool, exit_code: Option<i32>) -> SidecarExit {
    if quitting {
        return SidecarExit::Quitting;
    }
    match exit_code {
        Some(0) => SidecarExit::Restart,
        _ => SidecarExit::Crashed,
    }
}

fn spawn_child_monitor(app: AppHandle, pid: u32) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        let exit_status = {
            let state = app.state::<LauncherState>();
            let mut inner = state.inner.lock().expect("launcher state poisoned");
            let Some(service) = inner.service.as_mut() else {
                return;
            };
            if service.pid != pid {
                return;
            }
            match service.child.try_wait() {
                Ok(Some(status)) => Some(Ok((status.code(), status.to_string()))),
                Ok(None) => None,
                Err(err) => Some(Err(err.to_string())),
            }
        };
        let Some(status) = exit_status else {
            continue;
        };
        let paths = current_paths(&app).ok();
        // 持锁只做「改状态」,拿到的是一个二选一的结论 —— 拉起来还是摊开崩溃页。
        // 曾经这里回的是三态 `SidecarExit`,于是锁外还得再 match 一遍,而 `Quitting`
        // 那条 arm 在锁里就 return 了、永远到不了:三个分支在两处各写一遍,加一档状态
        // 得记着改两处。
        let restart = {
            let state = app.state::<LauncherState>();
            let mut inner = state.inner.lock().expect("launcher state poisoned");
            inner.service = None;
            let exit_code = status.as_ref().ok().and_then(|(code, _)| *code);
            match sidecar_exit_disposition(inner.quitting, exit_code) {
                SidecarExit::Quitting => return,
                SidecarExit::Restart => {
                    // 不在这里置 Starting:start_service_async 看到 Starting 会当成
                    // 「已经在启动」直接返回。
                    inner.status = LauncherStatus::Stopped;
                    inner.message =
                        "后端已按要求退出（应用更新 / 回退），正在重新拉起。".to_string();
                    inner.detail = None;
                    true
                }
                SidecarExit::Crashed => {
                    inner.status = LauncherStatus::Crashed;
                    inner.message = "后端服务已退出，请重试启动或查看日志。".to_string();
                    inner.detail = Some(match &status {
                        Ok((_, status)) => format!("sidecar exit status: {status}"),
                        Err(err) => format!("sidecar wait failed: {err}"),
                    });
                    false
                }
            }
        };
        if restart {
            if let Some(paths) = paths {
                append_launcher_log(
                    &paths.launcher_log_dir,
                    "sidecar exited with code 0: restarting to apply the update / rollback",
                );
            }
            start_service_async(app.clone());
        } else {
            if let Some(paths) = paths {
                append_launcher_log(&paths.launcher_log_dir, "sidecar exited unexpectedly");
            }
            show_status_page(&app);
        }
        return;
    });
}

fn stop_existing_service(app: &AppHandle, reason: &str) -> Result<(), String> {
    let service = {
        let state = app.state::<LauncherState>();
        let mut inner = state.inner.lock().expect("launcher state poisoned");
        inner.service.take()
    };
    let Some(mut service) = service else {
        return Ok(());
    };
    if let Ok(paths) = current_paths(app) {
        append_launcher_log(
            &paths.launcher_log_dir,
            &format!(
                "stopping sidecar reason={reason} pid={} port={} url={}",
                service.pid, service.port, service.url
            ),
        );
    }
    terminate_child(&mut service.child);
    let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
    loop {
        match service.child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = service.child.kill();
                let _ = service.child.wait();
                return Ok(());
            }
            Err(err) => return Err(format!("wait sidecar failed: {err}")),
        }
    }
}

#[cfg(unix)]
fn terminate_child(child: &mut Child) {
    let _ = nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id() as i32),
        nix::sys::signal::Signal::SIGTERM,
    );
}

#[cfg(not(unix))]
fn terminate_child(child: &mut Child) {
    let _ = child.kill();
}

fn mark_service_failed(app: &AppHandle, err: String) {
    {
        let state = app.state::<LauncherState>();
        let mut inner = state.inner.lock().expect("launcher state poisoned");
        if inner.quitting {
            return;
        }
        inner.status = LauncherStatus::Failed;
        inner.message = "后端服务启动失败，请重试或查看日志。".to_string();
        inner.detail = Some(err.clone());
        inner.panel_url = None;
    }
    if let Ok(paths) = current_paths(app) {
        append_launcher_log(
            &paths.launcher_log_dir,
            &format!("sidecar startup failed: {err}"),
        );
    }
    show_status_page(app);
}

fn generate_desktop_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    fill_random(&mut bytes)?;
    Ok(hex_encode(&bytes))
}

#[cfg(unix)]
fn fill_random(bytes: &mut [u8]) -> Result<(), String> {
    fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(bytes))
        .map_err(|err| format!("generate desktop token failed: {err}"))
}

#[cfg(windows)]
fn fill_random(bytes: &mut [u8]) -> Result<(), String> {
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x00000002;
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(
            h_algorithm: *mut std::ffi::c_void,
            pb_buffer: *mut u8,
            cb_buffer: u32,
            dw_flags: u32,
        ) -> i32;
    }
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(format!(
            "generate desktop token failed: BCryptGenRandom status={status}"
        ))
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn panel_url_with_token(base_url: &str, token: &str) -> String {
    format!("{base_url}/#{DESKTOP_TOKEN_QUERY}={token}")
}

fn allocate_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind((HOST, 0)).map_err(|err| format!("allocate port failed: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("read allocated port failed: {err}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn wait_for_health(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if health_ok(port) {
            return true;
        }
        thread::sleep(HEALTH_INTERVAL);
    }
    false
}

fn health_ok(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = String::new();
    if stream.read_to_string(&mut buf).is_err() {
        return false;
    }
    buf.starts_with("HTTP/1.1 200") || buf.starts_with("HTTP/1.0 200")
}

fn resolve_resources(app: &AppHandle) -> Result<ResourcePaths, String> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("resources"));
        candidates.push(resource_dir);
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));
    for root in candidates {
        let node =
            root.join("node")
                .join("bin")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
        let server_dir = root.join("app").join("apps").join("server");
        // 起的是 boot.mjs 而不是 index.mjs:它先决定跑哪一份载荷(安装包自带的,
        // 还是用户数据目录里那份更新过的),再在同一个进程里把它加载起来。
        let server_entry = server_dir.join("lib").join("boot.mjs");
        // dashboard 资源是 lib/index.mjs 的同级目录,服务端按入口就近找它 ——
        // 所以这里只做存在性检查,**不再用 --web-dist 指过去**(指过去就等于钉死
        // 安装包自带那份前端,应用内更新换了后端却换不掉界面)。
        let web_dist = server_dir.join("lib").join("web-dist");
        if node.is_file() && server_entry.is_file() && web_dist.join("index.html").is_file() {
            return Ok(ResourcePaths {
                root: child_process_path(&root),
                node: child_process_path(&node),
                server_dir: child_process_path(&server_dir),
                server_entry: child_process_path(&server_entry),
                web_dist: child_process_path(&web_dist),
            });
        }
    }
    Err(
        "找不到桌面资源，请先运行 vp run -F @bilibili-notify/desktop prepare-resources。"
            .to_string(),
    )
}

/// sidecar 的环境变量。抽成函数是为了能被测到 —— 尤其是 `BN_PARENT_PID`:
/// 它是个守卫的**唯一开关**,少了这一行 sidecar 侧的孤儿自检会静默失效,
/// 而且不会有任何东西报错。
fn apply_sidecar_env(command: &mut Command, desktop_token: &str, url: &str, parent_pid: u32) {
    sanitize_bn_env(command);
    command
        .env("BN_CONFIG_DISABLED", "1")
        .env("BN_ALLOW_NO_AUTH", "1")
        .env("BN_DESKTOP_TOKEN", desktop_token)
        .env("BN_DESKTOP_ALLOWED_ORIGIN", url)
        // 让 sidecar 认得自己的爹。launcher 被强杀时不会带走它 —— 它会被 launchd
        // 收养继续跑,占着数据目录,后续启动全撞车(2026-08-31 实地踩过)。拿到这个
        // pid 后 sidecar 自己会盯着 ppid,发现被收养就主动退出。
        .env("BN_PARENT_PID", parent_pid.to_string())
        .env("NODE_ENV", "production");
}

fn sanitize_bn_env(command: &mut Command) {
    for (key, _) in env::vars() {
        if key.starts_with("BN_") {
            command.env_remove(key);
        }
    }
}

fn create_launcher_paths() -> Result<LauncherPaths, Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    let (base, launcher_log_dir) = {
        let home = home_dir()?;
        (
            home.join("Library")
                .join("Application Support")
                .join("bilibili-notify"),
            home.join("Library")
                .join("Logs")
                .join("bilibili-notify")
                .join("launcher"),
        )
    };

    #[cfg(target_os = "windows")]
    let (base, launcher_log_dir) = {
        let base = windows_local_app_data_root()?.join("bilibili-notify");
        let launcher_log_dir = base.join("launcher-logs");
        (base, launcher_log_dir)
    };

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let (base, launcher_log_dir) = {
        let home = home_dir()?;
        let base = env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local").join("share"))
            .join("bilibili-notify");
        let launcher_log_dir = base.join("launcher-logs");
        (base, launcher_log_dir)
    };

    let data_dir = base.join("data");
    let server_log_dir = data_dir.join("logs");
    let settings_file = base.join("desktop-settings.json");
    fs::create_dir_all(&data_dir)?;
    fs::create_dir_all(&server_log_dir)?;
    fs::create_dir_all(&launcher_log_dir)?;
    Ok(LauncherPaths {
        data_dir,
        server_log_dir,
        launcher_log_dir,
        settings_file,
    })
}

#[cfg(not(target_os = "windows"))]
fn home_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    env_path("HOME")
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "HOME is not set").into())
}

#[cfg(target_os = "windows")]
fn windows_local_app_data_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    windows_local_app_data_root_from(|key| env::var_os(key)).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "LOCALAPPDATA / USERPROFILE / HOMEDRIVE+HOMEPATH are not set",
        )
        .into()
    })
}

#[cfg(any(target_os = "windows", test))]
fn windows_local_app_data_root_from(var: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    if let Some(local_app_data) = non_empty_path(var("LOCALAPPDATA")) {
        return Some(local_app_data);
    }
    if let Some(user_profile) = non_empty_path(var("USERPROFILE")) {
        return Some(user_profile.join("AppData").join("Local"));
    }
    let drive = non_empty_os_string(var("HOMEDRIVE"))?;
    let home_path = non_empty_os_string(var("HOMEPATH"))?;
    Some(
        PathBuf::from(format!(
            "{}{}",
            drive.to_string_lossy(),
            home_path.to_string_lossy()
        ))
        .join("AppData")
        .join("Local"),
    )
}

#[cfg(not(target_os = "windows"))]
fn env_path(key: &str) -> Option<PathBuf> {
    non_empty_path(env::var_os(key))
}

fn non_empty_path(value: Option<OsString>) -> Option<PathBuf> {
    non_empty_os_string(value).map(PathBuf::from)
}

fn non_empty_os_string(value: Option<OsString>) -> Option<OsString> {
    value.filter(|v| !v.is_empty())
}

fn current_paths(app: &AppHandle) -> Result<LauncherPaths, String> {
    let state = app.state::<LauncherState>();
    let inner = state.inner.lock().expect("launcher state poisoned");
    inner
        .paths
        .clone()
        .ok_or_else(|| "launcher paths are not initialized".to_string())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        activate_app(app);
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

fn navigate_main_window(app: &AppHandle, url: &str) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(url) = Url::parse(url) {
            let _ = window.navigate(url);
        }
        let _ = window.show();
        let _ = window.set_focus();
        activate_app(app);
    }
}

fn show_status_page(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.navigate(app_status_url(app));
        let _ = window.show();
        let _ = window.set_focus();
        activate_app(app);
    }
}

fn app_status_url(app: &AppHandle) -> Url {
    // 与 tauri 自身对 WebviewUrl::App 的解析同口径:dev 下前端由 vite dev
    // server(devUrl)供页,asset 协议里没有文件,硬导 tauri://localhost 会
    // 「asset not found: index.html」;产物构建才走 asset 协议。
    if tauri::is_dev() {
        if let Some(url) = app.config().build.dev_url.clone() {
            return url;
        }
    }
    Url::parse("tauri://localhost/index.html").expect("valid app status url")
}

fn open_panel(app: &AppHandle) {
    let _ = open_panel_result(app);
}

fn open_panel_result(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<LauncherState>();
    let inner = state.inner.lock().expect("launcher state poisoned");
    let url = inner
        .panel_url
        .clone()
        .ok_or_else(|| "Dashboard 尚未就绪。".to_string())?;
    open_url_with_system(&url)
}

enum KnownPath {
    Data,
    ServerLogs,
    LauncherLogs,
}

fn open_known_path(app: &AppHandle, kind: KnownPath) {
    let _ = open_known_path_result(app, kind);
}

fn open_known_path_result(app: &AppHandle, kind: KnownPath) -> Result<(), String> {
    let paths = current_paths(app)?;
    let path = match kind {
        KnownPath::Data => paths.data_dir,
        KnownPath::ServerLogs => paths.server_log_dir,
        KnownPath::LauncherLogs => paths.launcher_log_dir,
    };
    fs::create_dir_all(&path).map_err(|err| format!("create dir failed: {err}"))?;
    open_path_with_system(&path)
}

fn open_url_with_system(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return spawn_open_command(windows_explorer_open_command(OsStr::new(url)), url);

    #[cfg(target_os = "macos")]
    return spawn_open_command(open_command(OsStr::new(url)), url);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return spawn_open_command(xdg_open_command(OsStr::new(url)), url);
}

fn open_path_with_system(path: &Path) -> Result<(), String> {
    let target = path.display().to_string();
    #[cfg(target_os = "windows")]
    return spawn_open_command(windows_explorer_open_command(path.as_os_str()), &target);

    #[cfg(target_os = "macos")]
    return spawn_open_command(open_command(path.as_os_str()), &target);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return spawn_open_command(xdg_open_command(path.as_os_str()), &target);
}

#[cfg(target_os = "macos")]
fn open_command(target: &OsStr) -> Command {
    let mut command = Command::new("open");
    command.arg(target);
    command
}

#[cfg(any(target_os = "windows", test))]
fn windows_explorer_open_command(target: &OsStr) -> Command {
    let mut command = Command::new("explorer.exe");
    command.arg(target);
    command
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn xdg_open_command(target: &OsStr) -> Command {
    let mut command = Command::new("xdg-open");
    command.arg(target);
    command
}

fn spawn_open_command(mut command: Command, target: &str) -> Result<(), String> {
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("open {target} failed: {err}"))
}

fn request_quit(app: AppHandle) {
    thread::spawn(move || {
        prepare_for_exit(&app, "quit");
        app.exit(0);
    });
}

fn prepare_for_exit(app: &AppHandle, reason: &str) {
    {
        let state = app.state::<LauncherState>();
        let mut inner = state.inner.lock().expect("launcher state poisoned");
        inner.quitting = true;
        inner.status = LauncherStatus::Stopped;
        inner.message = "正在退出应用。".to_string();
        inner.detail = None;
    }
    if let Err(err) = stop_existing_service(app, reason) {
        if let Ok(paths) = current_paths(app) {
            append_launcher_log(
                &paths.launcher_log_dir,
                &format!("stop sidecar during exit failed: {err}"),
            );
        }
    }
}

fn toggle_dock(app: &AppHandle) {
    if let Err(err) = toggle_dock_result(app) {
        if let Ok(paths) = current_paths(app) {
            append_launcher_log(
                &paths.launcher_log_dir,
                &format!("toggle dock failed: {err}"),
            );
        }
    }
}

fn toggle_dock_result(app: &AppHandle) -> Result<bool, String> {
    let (current_hidden, next_hidden, tray_ready, settings_file) = {
        let state = app.state::<LauncherState>();
        let inner = state.inner.lock().expect("launcher state poisoned");
        let next_hidden = !inner.dock_hidden;
        let settings_file = inner.paths.as_ref().map(|p| p.settings_file.clone());
        (
            inner.dock_hidden,
            next_hidden,
            inner.tray_ready,
            settings_file,
        )
    };
    if !dock_toggle_supported() {
        return Err("当前平台不支持隐藏 Dock 图标。".to_string());
    }
    if next_hidden && !tray_ready {
        return Err("菜单栏图标不可用，不能隐藏 Dock 图标。".to_string());
    }
    set_dock_visible(app, !next_hidden)?;
    if let Some(settings_file) = settings_file {
        if let Err(err) = save_dock_hidden(&settings_file, next_hidden) {
            let _ = set_dock_visible(app, !current_hidden);
            return Err(err);
        }
    }
    let state = app.state::<LauncherState>();
    let mut inner = state.inner.lock().expect("launcher state poisoned");
    inner.dock_hidden = next_hidden;
    Ok(next_hidden)
}

fn dock_toggle_available(inner: &LauncherInner) -> bool {
    dock_toggle_supported() && (inner.dock_hidden || inner.tray_ready)
}

fn dock_toggle_supported() -> bool {
    cfg!(target_os = "macos")
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn activate_app(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| {
        use cocoa::{
            appkit::{NSApp, NSApplication},
            base::YES,
        };
        unsafe {
            NSApp().activateIgnoringOtherApps_(YES);
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn activate_app(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
fn set_dock_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    let policy = if visible {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };
    app.set_activation_policy(policy)
        .map_err(|err| format!("set dock visibility failed: {err}"))
}

#[cfg(not(target_os = "macos"))]
fn set_dock_visible(_app: &AppHandle, _visible: bool) -> Result<(), String> {
    Ok(())
}

fn load_dock_hidden(settings_file: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(settings_file) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("dockHidden").and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

fn save_dock_hidden(settings_file: &Path, hidden: bool) -> Result<(), String> {
    if let Some(parent) = settings_file.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("create settings dir failed: {err}"))?;
    }
    fs::write(
        settings_file,
        serde_json::json!({ "dockHidden": hidden }).to_string(),
    )
    .map_err(|err| format!("write settings failed: {err}"))
}

fn detect_browser_path() -> Option<PathBuf> {
    browser_candidates().into_iter().find(|path| path.is_file())
}

#[cfg(target_os = "macos")]
fn browser_candidates() -> Vec<PathBuf> {
    let home_apps = env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Applications"));
    let app_dirs = [Some(PathBuf::from("/Applications")), home_apps]
        .into_iter()
        .flatten();
    let browsers = [
        ("Google Chrome.app", "Contents/MacOS/Google Chrome"),
        ("Microsoft Edge.app", "Contents/MacOS/Microsoft Edge"),
        ("Chromium.app", "Contents/MacOS/Chromium"),
        ("Brave Browser.app", "Contents/MacOS/Brave Browser"),
    ];
    app_dirs
        .flat_map(|dir| browsers.map(move |(app, bin)| dir.join(app).join(bin)))
        .collect()
}

#[cfg(target_os = "windows")]
fn browser_candidates() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for key in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
        if let Some(value) = env::var_os(key) {
            roots.push(PathBuf::from(value));
        }
    }
    roots
        .iter()
        .flat_map(|root| {
            [
                root.join("Microsoft")
                    .join("Edge")
                    .join("Application")
                    .join("msedge.exe"),
                root.join("Google")
                    .join("Chrome")
                    .join("Application")
                    .join("chrome.exe"),
            ]
        })
        .collect()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn browser_candidates() -> Vec<PathBuf> {
    Vec::new()
}

fn append_launcher_log(log_dir: &Path, msg: &str) {
    let _ = fs::create_dir_all(log_dir);
    let path = log_dir.join("launcher.log");
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{ts} {msg}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // 这几条是「桌面版按『立即重启并应用』得到崩溃页」那个缺陷的守卫:服务端优雅退 0 是在
    // 请求重启,外壳得把它拉起来;只有非 0 / 被信号杀才是崩溃。
    #[test]
    fn clean_exit_asks_for_a_restart() {
        assert_eq!(
            sidecar_exit_disposition(false, Some(0)),
            SidecarExit::Restart
        );
    }

    #[test]
    fn non_zero_or_signal_is_a_crash() {
        assert_eq!(
            sidecar_exit_disposition(false, Some(1)),
            SidecarExit::Crashed
        );
        assert_eq!(sidecar_exit_disposition(false, None), SidecarExit::Crashed);
    }

    #[test]
    fn nothing_is_restarted_while_quitting() {
        assert_eq!(
            sidecar_exit_disposition(true, Some(0)),
            SidecarExit::Quitting
        );
        assert_eq!(
            sidecar_exit_disposition(true, Some(1)),
            SidecarExit::Quitting
        );
    }

    fn test_env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let vars: HashMap<String, OsString> = vars
            .iter()
            .map(|(key, value)| ((*key).to_string(), OsString::from(value)))
            .collect();
        move |key| vars.get(key).cloned()
    }

    #[test]
    fn sidecar_env_carries_parent_pid_so_the_orphan_watch_can_arm() {
        let mut command = Command::new("node");
        apply_sidecar_env(&mut command, "token", "http://127.0.0.1:1234", 4321);
        let envs: HashMap<String, Option<OsString>> = command
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_os_string()),
                )
            })
            .collect();
        assert_eq!(
            envs.get("BN_PARENT_PID").cloned().flatten(),
            Some(OsString::from("4321")),
            "少了 BN_PARENT_PID,sidecar 的孤儿自检会静默关掉"
        );
        assert_eq!(
            envs.get("BN_DESKTOP_TOKEN").cloned().flatten(),
            Some(OsString::from("token"))
        );
    }

    #[test]
    fn exit_requested_reason_separates_system_and_programmatic_exit() {
        assert_eq!(exit_requested_reason(None), "system exit");
        assert_eq!(exit_requested_reason(Some(0)), "programmatic exit code=0");
    }

    #[test]
    fn windows_open_command_uses_explorer_without_cmd_shell() {
        let target = r"C:\Users\akokko\AppData\Local\bilibili-notify"; // local-path-ok
        let command = windows_explorer_open_command(OsStr::new(target));
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert_eq!(command.get_program(), OsStr::new("explorer.exe"));
        assert_eq!(args, vec![target]);
    }

    #[test]
    fn windows_open_command_keeps_url_as_single_argument() {
        let command = windows_explorer_open_command(OsStr::new(
            "http://127.0.0.1:8787/#desktopToken=secret&keep=1",
        ));
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert_eq!(command.get_program(), OsStr::new("explorer.exe"));
        assert_eq!(
            args,
            vec!["http://127.0.0.1:8787/#desktopToken=secret&keep=1"]
        );
    }

    #[test]
    fn windows_verbatim_path_strips_drive_prefix_for_child_processes() {
        assert_eq!(
            strip_windows_verbatim_path(Path::new(
                r"\\?\C:\Users\akokko\bilibili-notify\resources\app", // local-path-ok
            )),
            PathBuf::from(r"C:\Users\akokko\bilibili-notify\resources\app") // local-path-ok
        );
    }

    #[test]
    fn windows_verbatim_path_strips_unc_prefix_for_child_processes() {
        assert_eq!(
            strip_windows_verbatim_path(Path::new(r"\\?\UNC\server\share\resources")),
            PathBuf::from(r"\\server\share\resources")
        );
    }

    #[test]
    fn windows_local_app_data_root_uses_localappdata_without_home() {
        let root = windows_local_app_data_root_from(test_env(&[(
            "LOCALAPPDATA",
            r"C:\Users\akokko\AppData\Local", // local-path-ok
        )]))
        .expect("root");

        assert_eq!(root, PathBuf::from(r"C:\Users\akokko\AppData\Local")); // local-path-ok
    }

    #[test]
    fn windows_local_app_data_root_falls_back_to_userprofile() {
        let root =
            windows_local_app_data_root_from(test_env(&[("USERPROFILE", r"C:\Users\akokko")])) // local-path-ok
                .expect("root");

        assert_eq!(
            root,
            PathBuf::from(r"C:\Users\akokko") // local-path-ok
                .join("AppData")
                .join("Local")
        );
    }

    #[test]
    fn windows_local_app_data_root_falls_back_to_homedrive_and_homepath() {
        let root = windows_local_app_data_root_from(test_env(&[
            ("HOMEDRIVE", "C:"),
            ("HOMEPATH", r"\Users\akokko"),
        ]))
        .expect("root");

        assert_eq!(
            root,
            PathBuf::from(r"C:\Users\akokko") // local-path-ok
                .join("AppData")
                .join("Local")
        );
    }
}
