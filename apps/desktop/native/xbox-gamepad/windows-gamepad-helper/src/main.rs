mod mapping;

use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{self, BufRead, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};
use windows::{
    Foundation::EventHandler,
    Gaming::Input::{Gamepad, RawGameController},
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};

const FAMILIES: [&str; 4] = ["xbox", "playstation", "nintendo", "generic"];

/// Keep Windows' hotplug subscription alive, but mutate devices only on the polling thread.
struct HotplugWatch {
    added: i64,
    removed: i64,
}

impl HotplugWatch {
    fn new(dirty: Arc<AtomicBool>) -> windows::core::Result<Self> {
        let added_dirty = dirty.clone();
        let added = Gamepad::GamepadAdded(&EventHandler::<Gamepad>::new(move |_, _| {
            added_dirty.store(true, Ordering::Relaxed);
            Ok(())
        }))?;
        match Gamepad::GamepadRemoved(&EventHandler::<Gamepad>::new(move |_, _| {
            dirty.store(true, Ordering::Relaxed);
            Ok(())
        })) {
            Ok(removed) => Ok(Self { added, removed }),
            Err(error) => {
                let _ = Gamepad::RemoveGamepadAdded(added);
                Err(error)
            }
        }
    }
}

impl Drop for HotplugWatch {
    fn drop(&mut self) {
        let _ = Gamepad::RemoveGamepadAdded(self.added);
        let _ = Gamepad::RemoveGamepadRemoved(self.removed);
    }
}

/// One active controller per family matches the existing Cindy accessory slots.
#[derive(Clone)]
struct Device {
    pad: Gamepad,
    id: String,
    name: String,
    last_frame: Option<Value>,
    triggers: mapping::TriggerState,
}

fn emit(value: &Value) -> io::Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, value)?;
    writeln!(out)?;
    out.flush()
}

fn presence(family: &str, device: Option<&Device>) -> io::Result<()> {
    emit(&match device {
        Some(device) => json!({ "kind": "presence", "family": family, "present": true,
            "name": device.name, "category": "Windows.Gaming.Input", "transport": "unknown" }),
        None => json!({ "kind": "presence", "family": family, "present": false }),
    })
}

/// Re-enumeration handles hotplug without callbacks racing the polling thread.
fn discover(
    current: &BTreeMap<&'static str, Device>,
) -> windows::core::Result<BTreeMap<&'static str, Device>> {
    let preferred = current
        .iter()
        .map(|(&family, device)| (family, device.id.clone()))
        .collect();
    let candidates = Gamepad::Gamepads()?
        .into_iter()
        .map(|pad| -> windows::core::Result<_> {
            let existing = current
                .iter()
                .find(|(_, device)| device.pad == pad)
                .map(|(&family, device)| (family, device));
            reuse_live_device(existing, || {
                let raw = RawGameController::FromGameController(&pad)?;
                let name = raw.DisplayName()?.to_string();
                let family = mapping::family(raw.HardwareVendorId()?, &name);
                let id = raw.NonRoamableId()?.to_string();
                Ok((
                    family,
                    Device {
                        pad,
                        id,
                        name,
                        last_frame: None,
                        triggers: mapping::TriggerState::default(),
                    },
                ))
            })
        });
    Ok(select_devices(candidates, &preferred, |device| {
        device.id.as_str()
    }))
}

/// Called only for a handle still present in the fresh Gamepads snapshot.
fn reuse_live_device<T: Clone, E>(
    existing: Option<(&'static str, &T)>,
    probe: impl FnOnce() -> std::result::Result<(&'static str, T), E>,
) -> std::result::Result<(&'static str, T), E> {
    // Metadata is stable for the lifetime of a WGI object. Fresh-list membership
    // and GetCurrentReading determine liveness, not a repeated DisplayName query.
    if let Some((family, device)) = existing {
        return Ok((family, device.clone()));
    }
    probe()
}

/// Select one stable device per family from independent metadata probes.
fn select_devices<T, E>(
    candidates: impl IntoIterator<Item = std::result::Result<(&'static str, T), E>>,
    preferred: &BTreeMap<&'static str, String>,
    id: impl Fn(&T) -> &str,
) -> BTreeMap<&'static str, T> {
    let mut devices = BTreeMap::new();
    for candidate in candidates {
        // Hot-unplug and broken metadata belong to this device, not the host's crash budget.
        let Ok((family, device)) = candidate else {
            continue;
        };
        let is_preferred = preferred.get(family).is_some_and(|old| old == id(&device));
        if !devices.contains_key(family) || is_preferred {
            devices.insert(family, device);
        }
    }
    devices
}

#[cfg(test)]
mod discovery_tests {
    use super::*;
    #[test]
    fn a_selected_live_handle_does_not_depend_on_fallible_metadata_refresh() {
        let old = "selected".to_string();
        let candidate = reuse_live_device(Some(("xbox", &old)), || Err("transient metadata error"));
        let selected = select_devices(
            [Ok(("xbox", "other".to_string())), candidate],
            &BTreeMap::from([("xbox", old.clone())]),
            |id| id.as_str(),
        );
        assert_eq!(selected.get("xbox"), Some(&old));
    }
    #[test]
    fn disappeared_handles_are_not_retained_by_cached_metadata() {
        let preferred = BTreeMap::from([("xbox", "removed".to_string())]);
        let candidate: std::result::Result<_, &str> =
            reuse_live_device(None, || Ok(("xbox", "replacement".to_string())));
        let selected = select_devices([candidate], &preferred, |id| id.as_str());
        assert_eq!(
            selected.get("xbox").map(String::as_str),
            Some("replacement")
        );
        let absent: Vec<std::result::Result<(&'static str, String), &str>> = Vec::new();
        assert!(select_devices(absent, &preferred, |id| id.as_str()).is_empty());
    }
    #[test]
    fn a_failed_device_probe_does_not_drop_healthy_devices() {
        let candidates = [
            Err("conversion failed"),
            Ok(("xbox", "first".to_string())),
            Err("property read failed"),
            Ok(("xbox", "selected".to_string())),
            Ok(("generic", "other".to_string())),
        ];
        let preferred = BTreeMap::from([("xbox", "selected".to_string())]);
        let selected = select_devices(candidates, &preferred, |id| id.as_str());
        assert_eq!(
            selected,
            BTreeMap::from([
                ("xbox", "selected".to_string()),
                ("generic", "other".to_string())
            ])
        );
    }
    #[test]
    fn all_failed_probes_leave_an_empty_snapshot_without_terminating_the_host() {
        let candidates: [std::result::Result<(&'static str, String), &str>; 2] =
            [Err("removed"), Err("unreadable")];
        let selected = select_devices(candidates, &BTreeMap::new(), |id| id.as_str());
        assert!(selected.is_empty());
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    // SAFETY: initialize WinRT once on the polling thread, before constructing any WinRT objects.
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }?;
    let result = poll();
    // SAFETY: all WinRT objects from poll have been dropped on this thread.
    unsafe { RoUninitialize() };
    result
}

fn poll() -> Result<(), Box<dyn std::error::Error>> {
    let dirty = Arc::new(AtomicBool::new(true));
    let _watch = HotplugWatch::new(dirty.clone())?;
    let (tx, rx) = mpsc::sync_channel(16);
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line == "stop" {
                break;
            }
            // The Switch 2 USB claim command belongs to the macOS HID backend.
            if line == "probe" && tx.send(()).is_err() {
                return;
            }
        }
        // Dropping the sender also stops on parent EOF/crash.
    });
    let mut devices = BTreeMap::<&'static str, Device>::new();
    let mut refresh = true;
    let mut last_scan = Instant::now();
    loop {
        if dirty.swap(false, Ordering::Relaxed)
            || refresh
            || last_scan.elapsed() >= Duration::from_secs(1)
        {
            let mut next = discover(&devices)?;
            for family in FAMILIES {
                let old = devices.get(family);
                let new = next.get_mut(family);
                let unchanged = match (old, new.as_deref()) {
                    (Some(a), Some(b)) => a.id == b.id,
                    (None, None) => true,
                    _ => false,
                };
                if unchanged {
                    if let (Some(old), Some(new)) = (old, new) {
                        new.triggers = old.triggers;
                        // Cached live devices also carry their last frame. Explicit
                        // probes must still emit a fresh sample for layout preview.
                        new.last_frame = if refresh {
                            None
                        } else {
                            old.last_frame.clone()
                        };
                    }
                } else if old.is_some() && new.is_some() {
                    // Reset held input before selecting a replacement controller.
                    presence(family, None)?;
                }
                if refresh || !unchanged {
                    presence(family, next.get(family))?;
                }
            }
            devices = next;
            refresh = false;
            last_scan = Instant::now();
        }
        let mut disconnected = Vec::new();
        for (&family, device) in &mut devices {
            match device.pad.GetCurrentReading() {
                Ok(reading) => {
                    let frame = mapping::frame(family, &reading, &mut device.triggers);
                    if device.last_frame.as_ref() != Some(&frame) {
                        emit(&frame)?;
                        device.last_frame = Some(frame);
                    }
                }
                Err(_) => {
                    presence(family, None)?;
                    disconnected.push(family);
                }
            }
        }
        for family in disconnected {
            devices.remove(family);
        }
        let interval = if devices.is_empty() {
            Duration::from_millis(250)
        } else {
            Duration::from_millis(16)
        };
        match rx.recv_timeout(interval) {
            Ok(()) => refresh = true,
            Err(mpsc::RecvTimeoutError::Timeout) => (),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

fn main() {
    if let Err(error) = run() {
        // stderr is consumed by the existing main-process logger and restart budget.
        eprintln!("Windows gamepad helper failed: {error}");
        std::process::exit(1);
    }
}
