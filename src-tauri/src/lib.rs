use gilrs::{Axis, Button, EventType, Gilrs};
use serde::Serialize;
use std::thread;
use std::time::Duration;
use tauri::Emitter;

/// Gamepad state snapshot emitted to the frontend at ~60 Hz.
/// Matches the browser Standard Gamepad layout so the TypeScript
/// code can consume it without any axis/button remapping.
#[derive(Clone, Serialize)]
struct GamepadState {
    /// [leftStickX, leftStickY, rightStickX, rightStickY]
    /// Y axes are negated to match browser convention (up = -1).
    axes: [f32; 4],
    /// 16 buttons in Standard Gamepad order.
    /// Index 12-15 = d-pad up/down/left/right.
    buttons: [bool; 16],
}

#[derive(Clone, Serialize)]
struct GamepadConnected {
    id: String,
}

/// Map gilrs buttons to Standard Gamepad indices.
fn button_index(btn: Button) -> Option<usize> {
    match btn {
        Button::South => Some(0),       // A / Cross
        Button::East => Some(1),        // B / Circle
        Button::West => Some(2),        // X / Square
        Button::North => Some(3),       // Y / Triangle
        Button::LeftTrigger => Some(4), // LB / L1
        Button::RightTrigger => Some(5),// RB / R1
        Button::LeftTrigger2 => Some(6),// LT / L2
        Button::RightTrigger2 => Some(7),// RT / R2
        Button::Select => Some(8),      // Back / Share
        Button::Start => Some(9),       // Start / Options
        Button::LeftThumb => Some(10),  // L3
        Button::RightThumb => Some(11), // R3
        Button::DPadUp => Some(12),
        Button::DPadDown => Some(13),
        Button::DPadLeft => Some(14),
        Button::DPadRight => Some(15),
        _ => None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let handle = app.handle().clone();
            thread::spawn(move || {
                let mut gilrs = match Gilrs::new() {
                    Ok(g) => g,
                    Err(e) => {
                        log::error!("[Gamepad] Failed to init gilrs: {e}");
                        return;
                    }
                };

                let mut active_id: Option<gilrs::GamepadId> = None;
                let mut state = GamepadState {
                    axes: [0.0; 4],
                    buttons: [false; 16],
                };

                loop {
                    // Process events (connect/disconnect/button/axis)
                    while let Some(ev) = gilrs.next_event() {
                        match ev.event {
                            EventType::Connected => {
                                if active_id.is_none() {
                                    active_id = Some(ev.id);
                                    let gp = gilrs.gamepad(ev.id);
                                    let name = gp.name().to_string();
                                    log::info!("[Gamepad] Connected: {name}");
                                    let _ = handle.emit("gamepad-connected", GamepadConnected { id: name });
                                }
                            }
                            EventType::Disconnected => {
                                if active_id == Some(ev.id) {
                                    log::info!("[Gamepad] Disconnected");
                                    active_id = None;
                                    state = GamepadState {
                                        axes: [0.0; 4],
                                        buttons: [false; 16],
                                    };
                                    let _ = handle.emit("gamepad-disconnected", ());
                                }
                            }
                            EventType::ButtonPressed(btn, _) => {
                                if active_id == Some(ev.id) {
                                    if let Some(idx) = button_index(btn) {
                                        state.buttons[idx] = true;
                                    }
                                }
                            }
                            EventType::ButtonReleased(btn, _) => {
                                if active_id == Some(ev.id) {
                                    if let Some(idx) = button_index(btn) {
                                        state.buttons[idx] = false;
                                    }
                                }
                            }
                            EventType::AxisChanged(axis, val, _) => {
                                if active_id == Some(ev.id) {
                                    match axis {
                                        Axis::LeftStickX => state.axes[0] = val,
                                        Axis::LeftStickY => state.axes[1] = -val, // negate: gilrs up=+1, browser up=-1
                                        Axis::RightStickX => state.axes[2] = val,
                                        Axis::RightStickY => state.axes[3] = -val,
                                        _ => {}
                                    }
                                }
                            }
                            _ => {}
                        }
                    }

                    // Emit state if a gamepad is active
                    if active_id.is_some() {
                        let _ = handle.emit("gamepad-state", state.clone());
                    }

                    thread::sleep(Duration::from_millis(16)); // ~60 Hz
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
