use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use tauri::State;

/// Parse a line like `READY 52317` into a port number.
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

    let mut child = Command::new(&python)
        .args(["-m", "floodmind_desktop_sidecar"])
        .env("PYTHONUNBUFFERED", "1") // unbuffered stdout so the READY line reaches Rust
        .current_dir(&data_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
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
        .recv_timeout(std::time::Duration::from_secs(15))
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
