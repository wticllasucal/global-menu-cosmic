// SPDX-License-Identifier: GPL-3.0-only
// Installed by the patch as src/wayland/handlers/global_menu.rs.
use crate::{
    shell::{CosmicSurface, focus::target::KeyboardFocusTarget},
    state::{Common, State},
};
use cosmic_global_menu_bridge::wayland_server::Resource;
use cosmic_global_menu_bridge::{
    ActiveWindow, FocusInput, GlobalMenuHandler, GlobalMenuState, WindowInfo,
};
use smithay::{
    desktop::{find_popup_root_surface, layer_map_for_output},
    utils::IsAlive,
    wayland::seat::WaylandFocus,
};

impl GlobalMenuHandler for State {
    fn global_menu_state(&mut self) -> &mut GlobalMenuState {
        &mut self.common.global_menu_state
    }
}
cosmic_global_menu_bridge::delegate_global_menu!(State);

impl Common {
    pub fn refresh_global_menu(&mut self) {
        let input = {
            let shell = self.shell.read();
            let focus = shell
                .seats
                .last_active()
                .get_keyboard()
                .and_then(|keyboard| keyboard.current_focus());
            if shell.session_lock.is_some() {
                FocusInput::Locked
            } else if let Some(window) = focus.as_ref().and_then(KeyboardFocusTarget::active_window)
            {
                FocusInput::Window(window)
            } else {
                match focus {
                    Some(KeyboardFocusTarget::LayerSurface(_)) => FocusInput::Panel,
                    Some(KeyboardFocusTarget::Popup(popup)) => {
                        let root = find_popup_root_surface(&popup).ok();
                        let selected = self.global_menu_focus.selected();
                        let own_popup = root.as_ref().is_some_and(|root| {
                            selected.is_some_and(|s| s.wl_surface().as_deref() == Some(root))
                        });
                        let layer_popup = root.as_ref().is_some_and(|root| {
                            shell.outputs().any(|output| {
                                layer_map_for_output(output)
                                    .layers()
                                    .any(|layer| layer.wl_surface() == root)
                            })
                        });
                        if own_popup || layer_popup {
                            FocusInput::Panel
                        } else {
                            FocusInput::Other
                        }
                    }
                    Some(KeyboardFocusTarget::LockSurface(_)) => FocusInput::Locked,
                    _ => FocusInput::Other,
                }
            }
        };
        let alive = self
            .global_menu_focus
            .selected()
            .is_some_and(|window| window.alive() && !window.is_minimized());
        let selected = self.global_menu_focus.observe(input, alive);
        let active = selected.and_then(|window| self.menu_window(&window));
        self.global_menu_state.set_active(active);
        self.global_menu_state.refresh();
    }

    fn menu_window(&mut self, window: &CosmicSurface) -> Option<ActiveWindow> {
        if !window.alive() || window.is_minimized() {
            return None;
        }
        let surface = window.wl_surface().map(|s| s.into_owned());
        let x11 = window.x11_surface();
        let xid = x11.map(|s| s.window_id()).unwrap_or(0);
        let pid = x11
            .and_then(|s| s.pid())
            .or_else(|| {
                surface
                    .as_ref()?
                    .client()?
                    .get_credentials(&self.display_handle)
                    .ok()
                    .and_then(|c| u32::try_from(c.pid).ok())
            })
            .unwrap_or(0);
        let id = if xid != 0 {
            (1u64 << 63) | u64::from(xid)
        } else {
            self.global_menu_state.surface_key(surface.as_ref()?).ok()?
        };
        Some(ActiveWindow {
            info: WindowInfo {
                id,
                app_id: window.app_id(),
                title: window.title(),
                pid,
                xid,
            },
            surface,
        })
    }
}
