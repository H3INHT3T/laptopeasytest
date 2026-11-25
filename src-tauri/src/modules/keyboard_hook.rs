use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawKeyEvent {
    pub vk_code: u32,
    pub scan_code: u32,
    pub code: String,
    pub pressed: bool,
}

#[cfg(target_os = "windows")]
mod win_hook {
    use super::*;
    use std::sync::Mutex;
    use tauri::Emitter;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, PeekMessageW, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, PM_REMOVE, WH_KEYBOARD_LL, WM_KEYDOWN,
        WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    static HOOK_APP: Mutex<Option<AppHandle>> = Mutex::new(None);
    static HOOK_ACTIVE: AtomicBool = AtomicBool::new(false);

    fn vk_to_dom_code(vk: u32, flags: u32) -> Option<&'static str> {
        let extended = (flags & 0x01) != 0;
        match vk {
            0x1B => Some("Escape"),
            0x70 => Some("F1"),
            0x71 => Some("F2"),
            0x72 => Some("F3"),
            0x73 => Some("F4"),
            0x74 => Some("F5"),
            0x75 => Some("F6"),
            0x76 => Some("F7"),
            0x77 => Some("F8"),
            0x78 => Some("F9"),
            0x79 => Some("F10"),
            0x7A => Some("F11"),
            0x7B => Some("F12"),
            0x2C => Some("PrintScreen"),
            0x91 => Some("ScrollLock"),
            0x13 => Some("Pause"),
            0x5B => Some("MetaLeft"),
            0x5C => Some("MetaRight"),
            0x5D => Some("ContextMenu"),
            0x09 => Some("Tab"),
            0x14 => Some("CapsLock"),
            0xA0 => Some("ShiftLeft"),
            0xA1 => Some("ShiftRight"),
            0xA2 => Some("ControlLeft"),
            0xA3 => Some("ControlRight"),
            0xA4 => Some("AltLeft"),
            0xA5 => Some("AltRight"),
            0x20 => Some("Space"),
            0x0D => Some(if extended { "NumpadEnter" } else { "Enter" }),
            0x08 => Some("Backspace"),
            0x2D => Some("Insert"),
            0x2E => Some("Delete"),
            0x24 => Some("Home"),
            0x23 => Some("End"),
            0x21 => Some("PageUp"),
            0x22 => Some("PageDown"),
            0x26 => Some("ArrowUp"),
            0x28 => Some("ArrowDown"),
            0x25 => Some("ArrowLeft"),
            0x27 => Some("ArrowRight"),
            _ => None,
        }
    }

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && HOOK_ACTIVE.load(Ordering::Relaxed) {
            let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
            let msg = wparam as u32;
            let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;

            if is_down || is_up {
                if let Some(dom_code) = vk_to_dom_code(kb.vkCode, kb.flags) {
                    if let Ok(guard) = HOOK_APP.lock() {
                        if let Some(app) = guard.as_ref() {
                            let _ = app.emit(
                                "keyboard:raw",
                                RawKeyEvent {
                                    vk_code: kb.vkCode,
                                    scan_code: kb.scanCode,
                                    code: dom_code.to_string(),
                                    pressed: is_down,
                                },
                            );
                        }
                    }
                    // Suppress Windows Start Menu & PrintScreen hijack while testing keyboard
                    if matches!(kb.vkCode, 0x5B | 0x5C | 0x2C | 0x5D) {
                        return 1;
                    }
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    pub fn start_hook(app: AppHandle, stop_flag: Arc<AtomicBool>) {
        if HOOK_ACTIVE.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut guard) = HOOK_APP.lock() {
            *guard = Some(app);
        }

        std::thread::spawn(move || unsafe {
            let hmod = GetModuleHandleW(std::ptr::null());
            let hook: HHOOK = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), hmod, 0);
            if hook.is_null() {
                HOOK_ACTIVE.store(false, Ordering::SeqCst);
                return;
            }

            let mut msg: MSG = std::mem::zeroed();
            while !stop_flag.load(Ordering::Relaxed) && HOOK_ACTIVE.load(Ordering::Relaxed) {
                while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                std::thread::sleep(std::time::Duration::from_millis(12));
            }

            UnhookWindowsHookEx(hook);
            HOOK_ACTIVE.store(false, Ordering::SeqCst);
        });
    }

    pub fn stop_hook() {
        HOOK_ACTIVE.store(false, Ordering::SeqCst);
    }
}

pub fn start_keyboard_capture(app: AppHandle, stop_flag: Arc<AtomicBool>) -> bool {
    #[cfg(target_os = "windows")]
    {
        win_hook::start_hook(app, stop_flag);
        true
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, stop_flag);
        false
    }
}

pub fn stop_keyboard_capture() {
    #[cfg(target_os = "windows")]
    {
        win_hook::stop_hook();
    }
}
