use serde::Serialize;
use std::{
    env,
    ffi::OsString,
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
    App, AppHandle, Manager, State, Url, WindowEvent,
};
#[cfg(target_os = "macos")]
use tauri::RunEvent;

const HOST: &str = "127.0.0.1";
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_INTERVAL: Duration = Duration::from_millis(350);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

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

    #[cfg(target_os = "macos")]
    app.run(|app, event| {
        if let RunEvent::Reopen { .. } = event {
            if let Ok(paths) = current_paths(app) {
                append_launcher_log(&paths.launcher_log_dir, "dock reopen");
            }
            show_main_window(app);
        }
    });
    #[cfg(not(target_os = "macos"))]
    app.run(|_app, _event| {});
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
    setup_menu(app)?;
    let tray_ready = match setup_tray(app) {
        Ok(()) => {
            append_launcher_log(&paths.launcher_log_dir, "tray ready");
            true
        }
        Err(err) => {
            append_launcher_log(&paths.launcher_log_dir, &format!("setup tray failed: {err}"));
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

fn setup_menu(app: &mut App) -> tauri::Result<()> {
    let menu = build_launcher_menu(app)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| handle_launcher_menu_event(app, event.id().as_ref()));
    Ok(())
}

fn setup_tray(app: &mut App) -> tauri::Result<()> {
    let menu = build_launcher_menu(app)?;
    let mut builder = TrayIconBuilder::with_id("bilibili-notify")
        .menu(&menu)
        .tooltip("Bilibili Notify")
        .show_menu_on_left_click(true);
    #[cfg(target_os = "macos")]
    {
        if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-logo.png")) {
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
    let show = MenuItem::with_id(app, "show_window", "显示/隐藏窗口", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open_panel", "用浏览器打开面板", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart_service", "重启服务", true, None::<&str>)?;
    let data = MenuItem::with_id(app, "open_data_dir", "打开数据目录", true, None::<&str>)?;
    let server_logs = MenuItem::with_id(
        app,
        "open_server_log_dir",
        "打开后端日志目录",
        true,
        None::<&str>,
    )?;
    let launcher_logs = MenuItem::with_id(
        app,
        "open_launcher_log_dir",
        "打开启动器日志目录",
        true,
        None::<&str>,
    )?;
    let dock = MenuItem::with_id(
        app,
        "toggle_dock",
        "隐藏/显示 Dock 图标",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit_app", "退出应用", true, Some("CmdOrCtrl+Q"))?;
    Menu::with_items(
        app,
        &[
            &show,
            &open,
            &restart,
            &data,
            &server_logs,
            &launcher_logs,
            &dock,
            &quit,
        ],
    )
}

fn handle_launcher_menu_event(app: &AppHandle, id: &str) {
    match id {
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
        if inner.status == LauncherStatus::Starting {
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
    let port = allocate_port()?;
    let url = format!("http://{HOST}:{port}");
    let browser = detect_browser_path();

    append_launcher_log(
        &paths.launcher_log_dir,
        &format!(
            "starting sidecar port={port} data_dir={} web_dist={} browser={}",
            paths.data_dir.display(),
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
        .arg(&paths.data_dir)
        .arg("--web-dist")
        .arg(&resources.web_dist)
        .current_dir(&resources.server_dir)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if let Some(chrome_path) = browser {
        command.arg("--chrome-path").arg(chrome_path);
    }
    sanitize_bn_env(&mut command);
    command
        .env("BN_CONFIG_DISABLED", "1")
        .env("BN_ALLOW_NO_AUTH", "1")
        .env("NODE_ENV", "production");

    let child = command
        .spawn()
        .map_err(|err| format!("spawn Node sidecar failed: {err}"))?;
    let pid = child.id();
    {
        let state = app.state::<LauncherState>();
        let mut inner = state.inner.lock().expect("launcher state poisoned");
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
            paths.data_dir.display(),
            paths.launcher_log_dir.display()
        ));
        inner.panel_url = Some(url.clone());
    }
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
        inner.status = LauncherStatus::Ready;
        inner.message = format!("Dashboard 已就绪：{url}");
        inner.detail = None;
        inner.panel_url = Some(url.clone());
    }
    append_launcher_log(&paths.launcher_log_dir, &format!("sidecar ready url={url}"));
    navigate_main_window(app, &url);
    Ok(())
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
                Ok(Some(status)) => Some(Ok(status.to_string())),
                Ok(None) => None,
                Err(err) => Some(Err(err.to_string())),
            }
        };
        let Some(status) = exit_status else {
            continue;
        };
        let paths = current_paths(&app).ok();
        {
            let state = app.state::<LauncherState>();
            let mut inner = state.inner.lock().expect("launcher state poisoned");
            let quitting = inner.quitting;
            inner.service = None;
            if quitting {
                return;
            }
            inner.status = LauncherStatus::Crashed;
            inner.message = "后端服务已退出，请重试启动或查看日志。".to_string();
            inner.detail = Some(match status {
                Ok(status) => format!("sidecar exit status: {status}"),
                Err(err) => format!("sidecar wait failed: {err}"),
            });
        }
        if let Some(paths) = paths {
            append_launcher_log(&paths.launcher_log_dir, "sidecar exited unexpectedly");
        }
        show_status_page(&app);
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
    if let Ok(paths) = current_paths(app) {
        append_launcher_log(
            &paths.launcher_log_dir,
            &format!("sidecar startup failed: {err}"),
        );
    }
    {
        let state = app.state::<LauncherState>();
        let mut inner = state.inner.lock().expect("launcher state poisoned");
        inner.status = LauncherStatus::Failed;
        inner.message = "后端服务启动失败，请重试或查看日志。".to_string();
        inner.detail = Some(err);
        inner.panel_url = None;
    }
    show_status_page(app);
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
        let server_entry = server_dir.join("lib").join("index.mjs");
        let web_dist = root.join("app").join("apps").join("web").join("dist");
        if node.is_file() && server_entry.is_file() && web_dist.join("index.html").is_file() {
            return Ok(ResourcePaths {
                root,
                node,
                server_dir,
                server_entry,
                web_dist,
            });
        }
    }
    Err(
        "找不到桌面资源，请先运行 vp run -F @bilibili-notify/desktop prepare-resources。"
            .to_string(),
    )
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
        let _ = window.navigate(app_status_url());
        let _ = window.show();
        let _ = window.set_focus();
        activate_app(app);
    }
}

fn app_status_url() -> Url {
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
    open_with_system(&url)
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
    open_with_system(&path.display().to_string())
}

fn open_with_system(target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(target);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", target]);
        command
    };

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(target);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("open {target} failed: {err}"))
}

fn request_quit(app: AppHandle) {
    thread::spawn(move || {
        {
            let state = app.state::<LauncherState>();
            let mut inner = state.inner.lock().expect("launcher state poisoned");
            inner.quitting = true;
            inner.status = LauncherStatus::Stopped;
            inner.message = "正在退出应用。".to_string();
        }
        let _ = stop_existing_service(&app, "quit");
        app.exit(0);
    });
}

fn toggle_dock(app: &AppHandle) {
    if let Err(err) = toggle_dock_result(app) {
        if let Ok(paths) = current_paths(app) {
            append_launcher_log(&paths.launcher_log_dir, &format!("toggle dock failed: {err}"));
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

    fn test_env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let vars: HashMap<String, OsString> = vars
            .iter()
            .map(|(key, value)| ((*key).to_string(), OsString::from(value)))
            .collect();
        move |key| vars.get(key).cloned()
    }

    #[test]
    fn windows_local_app_data_root_uses_localappdata_without_home() {
        let root = windows_local_app_data_root_from(test_env(&[(
            "LOCALAPPDATA",
            r"C:\Users\akokko\AppData\Local",
        )]))
        .expect("root");

        assert_eq!(root, PathBuf::from(r"C:\Users\akokko\AppData\Local"));
    }

    #[test]
    fn windows_local_app_data_root_falls_back_to_userprofile() {
        let root =
            windows_local_app_data_root_from(test_env(&[("USERPROFILE", r"C:\Users\akokko")]))
                .expect("root");

        assert_eq!(
            root,
            PathBuf::from(r"C:\Users\akokko")
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
            PathBuf::from(r"C:\Users\akokko")
                .join("AppData")
                .join("Local")
        );
    }
}
