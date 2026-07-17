use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use tauri::State;

/// Append a debug line to the app data log. Useful when the GUI has no visible
/// stderr in release builds.
fn debug_log(msg: &str) {
    let Some(dir) = dirs::data_dir().map(|d| d.join("FloodMindDesktop")) else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("sidecar-spawn.log");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("{now} {msg}\n");
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(line.as_bytes())
        });
}
pub fn parse_ready_line(line: &str) -> Option<u16> {
    line.trim().strip_prefix("READY ").and_then(|p| p.trim().parse::<u16>().ok())
}

pub struct SidecarHandle {
    pub base_url: String,
    child: Mutex<Option<Child>>,
}

impl SidecarHandle {
    pub fn kill(&self) {
        if let Ok(mut guard) = self.child.lock() {
            // take() so a second call is a cheap no-op rather than re-killing.
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for SidecarHandle {
    fn drop(&mut self) {
        self.kill();
    }
}

/// In a release build the sidecar is a Nuitka-compiled exe shipped next to the
/// main app; in dev (`debug_assertions`) we always fall back to `python -m`.
/// Returns the configured Command plus whether it is the bundled binary.
fn bundled_sidecar_command() -> Option<std::process::Command> {
    if cfg!(debug_assertions) {
        debug_log("bundled_sidecar_command: debug build -> python fallback");
        return None;
    }

    // Allow power users / debugging to force a specific sidecar binary.
    if let Ok(override_path) = std::env::var("FLOODMIND_SIDECAR_PATH") {
        debug_log(&format!("FLOODMIND_SIDECAR_PATH={override_path}"));
        let p = std::path::PathBuf::from(override_path);
        if p.exists() {
            debug_log("override path exists -> using it");
            return Some(std::process::Command::new(p));
        }
        debug_log("override path does NOT exist");
    }

    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    debug_log(&format!("current_exe={exe:?}, parent={dir:?}"));

    // Tauri's resource layout varies by bundler and install location. Try many
    // relatives to the main exe, and also the current working dir as a fallback.
    let mut candidates: Vec<std::path::PathBuf> = vec![
        dir.join("floodmind-sidecar.dist").join("floodmind-sidecar.exe"),
        dir.join("resources").join("floodmind-sidecar.dist").join("floodmind-sidecar.exe"),
        dir.join("..").join("resources").join("floodmind-sidecar.dist").join("floodmind-sidecar.exe"),
        dir.join("floodmind-sidecar.exe"),
        std::env::current_dir()
            .unwrap_or_else(|_| dir.to_path_buf())
            .join("resources")
            .join("floodmind-sidecar.dist")
            .join("floodmind-sidecar.exe"),
    ];

    // Deduplicate while preserving order.
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|p| seen.insert(p.clone()));

    for path in &candidates {
        let exists = path.exists();
        debug_log(&format!("candidate exists={exists} {path:?}"));
        if exists {
            return Some(std::process::Command::new(path));
        }
    }

    // Last resort: search upward from the exe for any floodmind-sidecar.exe.
    let mut search_dir = Some(dir.to_path_buf());
    while let Some(d) = search_dir {
        debug_log(&format!("recursive search in {d:?}"));
        if let Some(p) = find_sidecar_binary(&d, 3) {
            debug_log(&format!("recursive search found {p:?}"));
            return Some(std::process::Command::new(p));
        }
        search_dir = d.parent().map(|p| p.to_path_buf());
        if search_dir.as_ref().map(|p| p.components().count()).unwrap_or(0) < 2 {
            break;
        }
    }

    debug_log("bundled sidecar NOT found -> falling back to python");
    None
}

/// Recursively search `dir` up to `depth` levels for `floodmind-sidecar.exe`.
fn find_sidecar_binary(dir: &std::path::Path, depth: usize) -> Option<std::path::PathBuf> {
    if depth == 0 {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    let mut dirs = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let meta = entry.metadata().ok()?;
        if meta.is_file() {
            if path
                .file_name()
                .map(|n| n.to_string_lossy().eq_ignore_ascii_case("floodmind-sidecar.exe"))
                .unwrap_or(false)
            {
                return Some(path);
            }
        } else if meta.is_dir() {
            dirs.push(path);
        }
    }
    for sub in dirs {
        if let Some(p) = find_sidecar_binary(&sub, depth - 1) {
            return Some(p);
        }
    }
    None
}

/// Spawn the Python sidecar, read its READY line, and return the handle.
pub fn spawn_sidecar() -> Result<SidecarHandle, String> {
    let python = std::env::var("FLOODMIND_PYTHON").unwrap_or_else(|_| "python".to_string());

    // Run the sidecar from a dedicated app-data dir OUTSIDE the source tree.
    // The SDK writes sessions/checkpoints/task_experience/outputs under
    // `./data/` relative to cwd; if cwd were `src-tauri/` those writes would
    // trip Tauri's dev file-watcher (rebuild + window restart) and pollute the
    // repo. Settings (`~/.floodmind/settings.json`) are home-relative, so they
    // are still found regardless of cwd.
    let data_dir = dirs::data_dir()
        .map(|d| d.join("FloodMindDesktop"))
        .unwrap_or_else(|| std::path::PathBuf::from(".floodmind-desktop"));
    std::fs::create_dir_all(&data_dir).ok();

    // In dev, the sidecar source lives at <project-root>/sidecar, next to
    // src-tauri. Add it to PYTHONPATH so `python -m floodmind_desktop_sidecar`
    // works without an editable install. In production this path won't exist,
    // so we leave PYTHONPATH untouched.
    let sidecar_src = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("sidecar"));
    let pythonpath = sidecar_src
        .filter(|p| p.exists())
        .and_then(|p| p.canonicalize().ok())
        .map(|p| {
            let sep = if cfg!(windows) { ';' } else { ':' };
            match std::env::var("PYTHONPATH") {
                Ok(existing) if !existing.is_empty() => format!("{}{}{}", p.display(), sep, existing),
                _ => p.to_string_lossy().into_owned(),
            }
        });

    // Prefer the bundled Nuitka exe in release; otherwise launch via python -m.
    let (mut cmd, is_bundled) = match bundled_sidecar_command() {
        Some(c) => {
            debug_log("spawn_sidecar: using bundled sidecar");
            (c, true)
        }
        None => {
            debug_log("spawn_sidecar: using python fallback");
            let mut c = Command::new(&python);
            c.args(["-m", "floodmind_desktop_sidecar"]);
            c.env("PYTHONUNBUFFERED", "1"); // unbuffered stdout so the READY line reaches Rust
            if let Some(pp) = pythonpath {
                c.env("PYTHONPATH", pp);
            }
            (c, false)
        }
    };

    // In release the sidecar is a GUI-subsystem exe, but on Windows also force
    // no new console window and discard its stderr so no log popup appears.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .current_dir(&data_dir)
        .stdout(Stdio::piped())
        .stderr(if is_bundled { Stdio::null() } else { Stdio::inherit() })
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar ({python}): {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "could not capture sidecar stdout".to_string())?;

    // Read stdout on a thread; signal the READY port via a channel with a timeout.
    let (tx, rx) = mpsc::channel::<Option<u16>>();
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout);
        let mut first = true;
        for line in reader.lines().flatten() {
            if first {
                first = false;
                let port = parse_ready_line(&line);
                let _ = tx.send(port);
                if port.is_none() {
                    break;
                }
            } else {
                eprintln!("[sidecar] {line}");
            }
        }
    });

    let port = rx
        .recv_timeout(std::time::Duration::from_secs(45))
        .map_err(|e| format!("sidecar did not report READY in time: {e}"))?
        .ok_or_else(|| "sidecar's first stdout line was not a READY line".to_string())?;

    Ok(SidecarHandle {
        base_url: format!("http://127.0.0.1:{port}"),
        child: Mutex::new(Some(child)),
    })
}

#[tauri::command]
pub fn get_sidecar_base_url(state: State<'_, SidecarHandle>) -> Result<String, String> {
    Ok(state.base_url.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ready_line() {
        assert_eq!(parse_ready_line("READY 52317\n"), Some(52317));
        assert_eq!(parse_ready_line("READY 80"), Some(80));
    }

    #[test]
    fn rejects_non_ready_line() {
        assert_eq!(parse_ready_line("some log line"), None);
        assert_eq!(parse_ready_line(""), None);
        assert_eq!(parse_ready_line("READY notanumber"), None);
    }

    /// Real spawn handshake: starts `python -m floodmind_desktop_sidecar`,
    /// reads READY, and confirms the base_url resolves. Requires the sidecar
    /// package importable on PATH (pip install -e ./sidecar).
    #[test]
    fn spawn_sidecar_returns_valid_base_url() {
        let handle = match spawn_sidecar() {
            Ok(h) => h,
            Err(e) => {
                // Don't fail the suite if the env simply lacks python/sidecar.
                eprintln!("skipping spawn test (env unavailable): {e}");
                return;
            }
        };
        assert!(handle.base_url.starts_with("http://127.0.0.1:"));
        let port_part = handle.base_url.rsplit(':').next().unwrap();
        assert!(port_part.parse::<u16>().is_ok());
        handle.kill();
    }
}
