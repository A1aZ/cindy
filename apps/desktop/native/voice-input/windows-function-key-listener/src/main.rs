#[cfg(not(windows))]
fn main() {
    eprintln!("This helper is only supported on Windows.");
    std::process::exit(2);
}

#[cfg(windows)]
mod windows_listener {
    use std::io::{self, Write};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_F1, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU,
        VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION,
        KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    static TARGET_VK: AtomicU32 = AtomicU32::new(0);
    static MODIFIERS_DOWN: AtomicU32 = AtomicU32::new(0);
    static ACTIVE: AtomicBool = AtomicBool::new(false);
    static SUPPRESS_UNTIL_RELEASE: AtomicBool = AtomicBool::new(false);

    pub fn run() -> i32 {
        let Some(function_number) = parse_function_number() else {
            emit_error("Expected exactly one argument from F1 through F24.");
            return 2;
        };
        TARGET_VK.store(VK_F1 as u32 + function_number - 1, Ordering::Relaxed);
        MODIFIERS_DOWN.store(seed_modifier_state(), Ordering::Relaxed);

        let module = unsafe { GetModuleHandleW(std::ptr::null()) };
        if module.is_null() {
            emit_error("Could not resolve the Windows function key listener module.");
            return 3;
        }
        let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), module, 0) };
        if hook.is_null() {
            emit_error("Could not install the Windows keyboard listener.");
            return 3;
        }

        emit_line("{\"type\":\"ready\"}");
        let mut message: MSG = unsafe { std::mem::zeroed() };
        while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {}

        unsafe { UnhookWindowsHookEx(hook) };
        0
    }

    unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code != HC_ACTION as i32 {
            return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
        }

        let event = &*(lparam as *const KBDLLHOOKSTRUCT);
        let target_vk = TARGET_VK.load(Ordering::Relaxed);
        let message = wparam as u32;
        let key_down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
        let key_up = message == WM_KEYUP || message == WM_SYSKEYUP;
        let modifier_bit = modifier_bit(event.vkCode);

        if modifier_bit != 0 {
            if key_down {
                MODIFIERS_DOWN.fetch_or(modifier_bit, Ordering::Relaxed);
            } else if key_up {
                MODIFIERS_DOWN.fetch_and(!modifier_bit, Ordering::Relaxed);
            }
        }

        if key_down && event.vkCode != target_vk && ACTIVE.swap(false, Ordering::Relaxed) {
            emit_canceled();
        }

        if event.vkCode == target_vk {
            if key_down {
                if ACTIVE.load(Ordering::Relaxed) || SUPPRESS_UNTIL_RELEASE.load(Ordering::Relaxed)
                {
                    return 1;
                }
                if MODIFIERS_DOWN.load(Ordering::Relaxed) == 0 {
                    ACTIVE.store(true, Ordering::Relaxed);
                    SUPPRESS_UNTIL_RELEASE.store(true, Ordering::Relaxed);
                    emit_pressed(true);
                    return 1;
                }
            } else if key_up && SUPPRESS_UNTIL_RELEASE.swap(false, Ordering::Relaxed) {
                if ACTIVE.swap(false, Ordering::Relaxed) {
                    emit_pressed(false);
                }
                return 1;
            }
        }

        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    fn parse_function_number() -> Option<u32> {
        let value = std::env::args().nth(1)?;
        let number = value.strip_prefix('F')?.parse::<u32>().ok()?;
        (1..=24).contains(&number).then_some(number)
    }

    fn modifier_bit(vk: u32) -> u32 {
        match vk as u16 {
            VK_SHIFT => 1 << 0,
            VK_LSHIFT => 1 << 1,
            VK_RSHIFT => 1 << 2,
            VK_CONTROL => 1 << 3,
            VK_LCONTROL => 1 << 4,
            VK_RCONTROL => 1 << 5,
            VK_MENU => 1 << 6,
            VK_LMENU => 1 << 7,
            VK_RMENU => 1 << 8,
            VK_LWIN => 1 << 9,
            VK_RWIN => 1 << 10,
            _ => 0,
        }
    }

    fn seed_modifier_state() -> u32 {
        [
            VK_LSHIFT,
            VK_RSHIFT,
            VK_LCONTROL,
            VK_RCONTROL,
            VK_LMENU,
            VK_RMENU,
            VK_LWIN,
            VK_RWIN,
        ]
        .into_iter()
        .fold(0, |state, vk| {
            let is_down = unsafe { GetAsyncKeyState(vk as i32) } < 0;
            if is_down {
                state | modifier_bit(vk as u32)
            } else {
                state
            }
        })
    }

    fn emit_pressed(pressed: bool) {
        emit_line(if pressed {
            "{\"type\":\"pressed\",\"pressed\":true}"
        } else {
            "{\"type\":\"pressed\",\"pressed\":false}"
        });
    }

    fn emit_canceled() {
        emit_line("{\"type\":\"canceled\"}");
    }

    fn emit_error(message: &str) {
        let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");
        emit_line(&format!("{{\"type\":\"error\",\"message\":\"{escaped}\"}}"));
    }

    fn emit_line(line: &str) {
        let mut stdout = io::stdout().lock();
        let _ = writeln!(stdout, "{line}");
        let _ = stdout.flush();
    }
}

#[cfg(windows)]
fn main() {
    std::process::exit(windows_listener::run());
}
