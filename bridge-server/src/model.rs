// SPDX-License-Identifier: GPL-3.0-only
use std::collections::HashMap;
use zbus_names::BusName;

pub const MAX_SURFACES: usize = 4096;
pub const MAX_ADDRESS: usize = 1024;

pub fn valid_path(path: &str) -> bool {
    path.len() <= MAX_ADDRESS
        && (path == "/"
            || (path.starts_with('/')
                && path[1..].split('/').all(|part| {
                    !part.is_empty() && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                })))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DbusAddress {
    pub bus_name: String,
    pub path: String,
}

impl DbusAddress {
    pub fn new(bus_name: &str, path: &str) -> Result<Self, String> {
        if bus_name.len() > 255 || BusName::try_from(bus_name).is_err() || !valid_path(path) {
            return Err("Destino D-Bus no válido".into());
        }
        Ok(Self {
            bus_name: bus_name.into(),
            path: path.into(),
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GtkAddress {
    pub bus_name: String,
    pub menubar_path: String,
    pub app_menu_path: String,
    pub application_path: String,
    pub window_path: String,
}

impl GtkAddress {
    pub fn validate(&self) -> Result<(), String> {
        if self.bus_name.len() > 255 || BusName::try_from(self.bus_name.as_str()).is_err() {
            return Err("Nombre de bus GTK no válido".into());
        }
        for path in [
            &self.menubar_path,
            &self.app_menu_path,
            &self.application_path,
            &self.window_path,
        ] {
            if !path.is_empty() && !valid_path(path) {
                return Err("Ruta GTK no válida".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SurfaceMenus {
    pub dbusmenu: Option<DbusAddress>,
    pub gtk: Option<GtkAddress>,
}

#[derive(Default, Debug)]
pub struct MenuRegistry {
    menus: HashMap<u64, SurfaceMenus>,
}

impl MenuRegistry {
    pub fn set_dbusmenu(&mut self, surface: u64, bus: &str, path: &str) -> Result<(), String> {
        if bus.is_empty() && path.is_empty() {
            self.clear_dbusmenu(surface);
            return Ok(());
        }
        let address = DbusAddress::new(bus, path)?;
        self.check_capacity(surface)?;
        self.menus.entry(surface).or_default().dbusmenu = Some(address);
        Ok(())
    }

    pub fn set_gtk(&mut self, surface: u64, address: GtkAddress) -> Result<(), String> {
        if address.bus_name.is_empty() {
            self.clear_gtk(surface);
            return Ok(());
        }
        address.validate()?;
        self.check_capacity(surface)?;
        self.menus.entry(surface).or_default().gtk = Some(address);
        Ok(())
    }

    fn check_capacity(&self, surface: u64) -> Result<(), String> {
        if self.menus.len() >= MAX_SURFACES && !self.menus.contains_key(&surface) {
            return Err("Demasiadas superficies con menú".into());
        }
        Ok(())
    }

    pub fn get(&self, surface: u64) -> Option<&SurfaceMenus> {
        self.menus.get(&surface)
    }

    pub fn remove(&mut self, surface: u64) {
        self.menus.remove(&surface);
    }

    pub fn clear_dbusmenu(&mut self, surface: u64) {
        if let Some(menus) = self.menus.get_mut(&surface) {
            menus.dbusmenu = None;
        }
        self.remove_empty(surface);
    }

    pub fn clear_gtk(&mut self, surface: u64) {
        if let Some(menus) = self.menus.get_mut(&surface) {
            menus.gtk = None;
        }
        self.remove_empty(surface);
    }

    fn remove_empty(&mut self, surface: u64) {
        if self
            .menus
            .get(&surface)
            .is_some_and(|m| m.dbusmenu.is_none() && m.gtk.is_none())
        {
            self.remove(surface);
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WindowInfo {
    pub id: u64,
    pub app_id: String,
    pub title: String,
    pub pid: u32,
    pub xid: u32,
}

#[derive(Clone, Debug)]
pub enum FocusInput<T = WindowInfo> {
    Window(T),
    Panel,
    Locked,
    Other,
}

#[derive(Debug)]
pub struct FocusPolicy<T = WindowInfo> {
    selected: Option<T>,
}

impl<T> Default for FocusPolicy<T> {
    fn default() -> Self {
        Self { selected: None }
    }
}

impl<T: Clone> FocusPolicy<T> {
    pub fn observe(&mut self, input: FocusInput<T>, selected_alive: bool) -> Option<T> {
        self.selected = match input {
            FocusInput::Window(window) => Some(window),
            FocusInput::Panel if selected_alive => self.selected.clone(),
            FocusInput::Panel | FocusInput::Locked | FocusInput::Other => None,
        };
        self.selected.clone()
    }

    pub fn selected(&self) -> Option<&T> {
        self.selected.as_ref()
    }
}
