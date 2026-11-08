use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) enum LauncherLogEvent<'a> {
    DockReopen,
    Setup,
    TrayReady,
    TrayFailed {
        error: &'a str,
    },
    SidecarStarting {
        port: u16,
        data_dir: &'a Path,
        web_dist: &'a Path,
        browser_detected: bool,
    },
    SidecarReady {
        url: &'a str,
    },
    SidecarRestart,
    SidecarCrashed,
    SidecarStopping {
        reason: &'a str,
        pid: u32,
        port: u16,
        url: &'a str,
    },
    SidecarStartFailed {
        error: &'a str,
    },
    ExitStopFailed {
        error: &'a str,
    },
    DockToggleFailed {
        error: &'a str,
    },
}

// The launcher has not read the host language setting. ADR-0039 keeps the plain
// Simplified Chinese startup fallback here; the OS locale only selects a mirror.
fn startup_message(key: &str) -> &'static str {
    static MESSAGES: OnceLock<HashMap<String, String>> = OnceLock::new();
    let messages = MESSAGES.get_or_init(|| {
        serde_json::from_str(include_str!("../locales/zh-CN.json"))
            .expect("bundled launcher messages must be valid JSON")
    });
    messages.get(key).expect("launcher message must exist")
}

fn redact_desktop_token(value: &str) -> String {
    let marker = format!("{}=", super::DESKTOP_TOKEN_QUERY);
    let mut rest = value;
    let mut redacted = String::with_capacity(value.len());
    while let Some(index) = rest.find(&marker) {
        let start = index + marker.len();
        redacted.push_str(&rest[..start]);
        rest = &rest[start..];
        let end = rest
            .find(|c: char| c.is_whitespace() || matches!(c, '&' | '#' | '"' | '\'' | '<' | '>'))
            .unwrap_or(rest.len());
        redacted.push_str("[REDACTED]");
        rest = &rest[end..];
    }
    redacted.push_str(rest);
    redacted
}

impl LauncherLogEvent<'_> {
    fn text(&self) -> String {
        let key = match self {
            Self::DockReopen => "log.desktop.dockReopen",
            Self::Setup => "log.desktop.setup",
            Self::TrayReady => "log.desktop.trayReady",
            Self::TrayFailed { .. } => "log.desktop.trayFailed",
            Self::SidecarStarting { .. } => "log.desktop.sidecarStarting",
            Self::SidecarReady { .. } => "log.desktop.sidecarReady",
            Self::SidecarRestart => "log.desktop.sidecarRestart",
            Self::SidecarCrashed => "log.desktop.sidecarCrashed",
            Self::SidecarStopping { .. } => "log.desktop.sidecarStopping",
            Self::SidecarStartFailed { .. } => "log.desktop.sidecarStartFailed",
            Self::ExitStopFailed { .. } => "log.desktop.exitStopFailed",
            Self::DockToggleFailed { .. } => "log.desktop.dockToggleFailed",
        };
        let message = startup_message(key);
        let diagnostics = match self {
            Self::TrayFailed { error }
            | Self::SidecarStartFailed { error }
            | Self::ExitStopFailed { error }
            | Self::DockToggleFailed { error } => Some(serde_json::json!({ "error": error })),
            Self::SidecarStarting {
                port,
                data_dir,
                web_dist,
                browser_detected,
            } => Some(serde_json::json!({
                "port": port,
                "data_dir": data_dir.display().to_string(),
                "web_dist": web_dist.display().to_string(),
                "browser": if *browser_detected { "detected" } else { "none" },
            })),
            Self::SidecarReady { url } => Some(serde_json::json!({ "url": url })),
            Self::SidecarStopping {
                reason,
                pid,
                port,
                url,
            } => Some(serde_json::json!({
                "reason": reason, "pid": pid, "port": port, "url": url,
            })),
            _ => None,
        };
        if let Some(mut diagnostics) = diagnostics {
            // These fields are a flat diagnostic object, never a request or environment dump.
            for value in diagnostics
                .as_object_mut()
                .expect("diagnostic fields")
                .values_mut()
            {
                if let serde_json::Value::String(value) = value {
                    *value = redact_desktop_token(value);
                }
            }
            format!("{message} {diagnostics}")
        } else {
            message.to_string()
        }
    }
}

pub(super) fn append_launcher_log(log_dir: &Path, event: LauncherLogEvent<'_>) {
    let msg = event.text();
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
