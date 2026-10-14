// SPDX-License-Identifier: GPL-3.0-only
pub use cosmic_global_menu_bridge::{DbusAddress, FocusInput, FocusPolicy, GtkAddress, WindowInfo};
use std::sync::Arc;
use zbus::zvariant::{OwnedValue, Signature};

#[derive(Clone, Debug)]
pub enum ActionKind {
    DbusMenu(i32),
    Gtk {
        name: String,
        target: Option<Arc<OwnedValue>>,
        parameter: Signature,
    },
    GtkSubmenu(String),
}

#[derive(Clone, Debug)]
pub struct MenuAction {
    /// Always a unique bus owner, never a reassignable well-known name.
    pub address: DbusAddress,
    pub kind: ActionKind,
    pub enabled: bool,
}

#[derive(Clone, Debug, Default)]
pub struct MenuNode {
    pub label: String,
    pub enabled: bool,
    pub visible: bool,
    pub separator: bool,
    pub submenu: bool,
    pub checked: Option<bool>,
    pub action: Option<MenuAction>,
    pub children: Vec<MenuNode>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WindowSnapshot {
    pub serial: u32,
    pub window: Option<WindowInfo>,
    pub dbusmenu: Option<DbusAddress>,
    pub gtk: Option<GtkAddress>,
}

#[derive(Clone, Debug)]
pub enum BridgeEvent {
    Active(u32, WindowInfo),
    DbusMenu(u32, String, String),
    GtkMenu(u32, GtkAddress),
    Clear(u32),
    Done(u32),
}

#[derive(Default, Debug)]
pub struct SnapshotAssembler {
    pending: Option<WindowSnapshot>,
    published: Option<u32>,
}

fn newer(serial: u32, old: u32) -> bool {
    serial != old && serial.wrapping_sub(old) < 0x8000_0000
}

impl SnapshotAssembler {
    pub fn push(&mut self, event: BridgeEvent) -> Option<WindowSnapshot> {
        match event {
            BridgeEvent::Active(serial, window) => self.begin(serial, Some(window)),
            BridgeEvent::Clear(serial) => self.begin(serial, None),
            BridgeEvent::DbusMenu(serial, bus, path) => {
                if let Some(pending) = self.pending.as_mut().filter(|s| s.serial == serial) {
                    pending.dbusmenu = DbusAddress::new(&bus, &path).ok();
                }
            }
            BridgeEvent::GtkMenu(serial, address) => {
                if let Some(pending) = self.pending.as_mut().filter(|s| s.serial == serial) {
                    if address.validate().is_ok() {
                        pending.gtk = Some(address);
                    }
                }
            }
            BridgeEvent::Done(serial) => {
                if self.pending.as_ref().is_some_and(|s| s.serial == serial) {
                    self.published = Some(serial);
                    return self.pending.take();
                }
            }
        }
        None
    }

    fn begin(&mut self, serial: u32, window: Option<WindowInfo>) {
        if self.published.is_some_and(|old| !newer(serial, old))
            || self
                .pending
                .as_ref()
                .is_some_and(|s| !newer(serial, s.serial))
        {
            return;
        }
        self.pending = Some(WindowSnapshot {
            serial,
            window,
            ..Default::default()
        });
    }
}
