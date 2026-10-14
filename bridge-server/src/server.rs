// SPDX-License-Identifier: GPL-3.0-only
use crate::protocols::server::{
    appmenu::{
        org_kde_kwin_appmenu::{self, OrgKdeKwinAppmenu},
        org_kde_kwin_appmenu_manager::{self, OrgKdeKwinAppmenuManager},
    },
    bridge::zglobal_menu_bridge_v1::{self, ZglobalMenuBridgeV1},
    gtk::{
        gtk_shell1::{self, GtkShell1},
        gtk_surface1::{self, GtkSurface1},
    },
};
use crate::{GtkAddress, MAX_SURFACES, MenuRegistry, SurfaceMenus, WindowInfo};
use std::{collections::HashMap, sync::Arc};
use wayland_server::{
    Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource,
    backend::{ClientId, ObjectId},
    protocol::wl_surface::WlSurface,
};

#[derive(Clone, Debug)]
pub struct ActiveWindow {
    pub info: WindowInfo,
    pub surface: Option<WlSurface>,
}

pub trait GlobalMenuHandler: Sized {
    fn global_menu_state(&mut self) -> &mut GlobalMenuState;
}

#[derive(Clone)]
pub struct BridgeGlobalData(pub Arc<dyn Fn(&Client) -> bool + Send + Sync>);

#[derive(Clone, Debug)]
pub struct SurfaceResourceData {
    pub surface: WlSurface,
    pub key: u64,
}

#[derive(Debug)]
struct SurfaceRecord {
    data: SurfaceResourceData,
    dbus_owner: Option<ObjectId>,
    gtk_owner: Option<ObjectId>,
}

#[derive(Clone, Default, Debug, PartialEq, Eq)]
struct Published {
    window: Option<WindowInfo>,
    menus: SurfaceMenus,
}

pub struct GlobalMenuState {
    registry: MenuRegistry,
    surfaces: HashMap<ObjectId, SurfaceRecord>,
    next_key: u64,
    active: Option<ActiveWindow>,
    bridges: Vec<ZglobalMenuBridgeV1>,
    gtk_shells: Vec<GtkShell1>,
    serial: u32,
    last: Option<Published>,
    capabilities: u32,
}

impl std::fmt::Debug for GlobalMenuState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GlobalMenuState")
            .field("surfaces", &self.surfaces.len())
            .field("active", &self.active)
            .finish()
    }
}

impl GlobalMenuState {
    pub fn new<D>(
        display: &DisplayHandle,
        filter: impl Fn(&Client) -> bool + Send + Sync + 'static,
    ) -> Self
    where
        D: GlobalDispatch<OrgKdeKwinAppmenuManager, ()>
            + GlobalDispatch<GtkShell1, ()>
            + GlobalDispatch<ZglobalMenuBridgeV1, BridgeGlobalData>
            + 'static,
    {
        display.create_global::<D, OrgKdeKwinAppmenuManager, _>(2, ());
        display.create_global::<D, GtkShell1, _>(1, ());
        display.create_global::<D, ZglobalMenuBridgeV1, _>(1, BridgeGlobalData(Arc::new(filter)));
        Self {
            registry: MenuRegistry::default(),
            surfaces: HashMap::new(),
            next_key: 1,
            active: None,
            bridges: Vec::new(),
            gtk_shells: Vec::new(),
            serial: 0,
            last: None,
            capabilities: 0,
        }
    }

    pub fn surface_key(&mut self, surface: &WlSurface) -> Result<u64, String> {
        if let Some(record) = self.surfaces.get(&surface.id()) {
            return Ok(record.data.key);
        }
        if self.surfaces.len() >= MAX_SURFACES {
            return Err("Demasiadas superficies".into());
        }
        let key = self.next_key;
        self.next_key = self
            .next_key
            .checked_add(1)
            .ok_or("Identificadores agotados")?;
        self.surfaces.insert(
            surface.id(),
            SurfaceRecord {
                data: SurfaceResourceData {
                    surface: surface.clone(),
                    key,
                },
                dbus_owner: None,
                gtk_owner: None,
            },
        );
        Ok(key)
    }

    pub fn set_active(&mut self, active: Option<ActiveWindow>) {
        self.active = active;
    }
    pub fn active(&self) -> Option<&ActiveWindow> {
        self.active.as_ref()
    }

    fn published(&self) -> Published {
        match self.active.as_ref() {
            Some(active) if active.surface.as_ref().is_none_or(Resource::is_alive) => {
                let menus = active
                    .surface
                    .as_ref()
                    .and_then(|surface| self.surfaces.get(&surface.id()))
                    .and_then(|record| self.registry.get(record.data.key))
                    .cloned()
                    .unwrap_or_default();
                let mut info = active.info.clone();
                info.title = clean_label(&info.title, 200);
                info.app_id = clean_label(&info.app_id, 255);
                Published {
                    window: Some(info),
                    menus,
                }
            }
            _ => Published::default(),
        }
    }

    pub fn refresh(&mut self) {
        let registry = &mut self.registry;
        self.surfaces.retain(|_, record| {
            if record.data.surface.is_alive() {
                true
            } else {
                registry.remove(record.data.key);
                false
            }
        });
        if self
            .active
            .as_ref()
            .is_some_and(|a| a.surface.as_ref().is_some_and(|s| !s.is_alive()))
        {
            self.active = None;
        }
        self.bridges.retain(Resource::is_alive);
        self.gtk_shells.retain(Resource::is_alive);
        // GTK represents each capability enum entry as a bit position.
        let caps = if self.bridges.is_empty() {
            0
        } else {
            1 << gtk_shell1::Capability::GlobalMenuBar as u32
        };
        if caps != self.capabilities {
            self.capabilities = caps;
            for shell in &self.gtk_shells {
                shell.capabilities(caps);
            }
        }
        let published = self.published();
        if self.last.as_ref() != Some(&published) {
            self.serial = self.serial.wrapping_add(1);
            for bridge in &self.bridges {
                send_snapshot(bridge, self.serial, &published);
            }
            self.last = Some(published);
        }
    }

    fn resource_data(&mut self, surface: &WlSurface) -> Result<SurfaceResourceData, String> {
        Ok(SurfaceResourceData {
            surface: surface.clone(),
            key: self.surface_key(surface)?,
        })
    }
}

fn clean_label(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect()
}

fn send_snapshot(bridge: &ZglobalMenuBridgeV1, serial: u32, state: &Published) {
    if let Some(window) = &state.window {
        bridge.active(
            serial,
            window.id.to_string(),
            window.app_id.clone(),
            window.title.clone(),
            window.pid,
            window.xid,
        );
        if let Some(address) = &state.menus.dbusmenu {
            bridge.dbusmenu(serial, address.bus_name.clone(), address.path.clone());
        }
        if let Some(address) = &state.menus.gtk {
            bridge.gtk_menu(
                serial,
                address.bus_name.clone(),
                address.menubar_path.clone(),
                address.app_menu_path.clone(),
                address.application_path.clone(),
                address.window_path.clone(),
            );
        }
    } else {
        bridge.clear(serial);
    }
    bridge.done(serial);
}

impl<D> GlobalDispatch<ZglobalMenuBridgeV1, BridgeGlobalData, D> for GlobalMenuState
where
    D: GlobalDispatch<ZglobalMenuBridgeV1, BridgeGlobalData>
        + Dispatch<ZglobalMenuBridgeV1, ()>
        + GlobalMenuHandler
        + 'static,
{
    fn bind(
        state: &mut D,
        _: &DisplayHandle,
        _: &Client,
        resource: New<ZglobalMenuBridgeV1>,
        _: &BridgeGlobalData,
        init: &mut DataInit<'_, D>,
    ) {
        let bridge = init.init(resource, ());
        let menus = state.global_menu_state();
        menus.bridges.push(bridge.clone());
        menus.refresh();
        send_snapshot(&bridge, menus.serial, &menus.published());
    }
    fn can_view(client: Client, data: &BridgeGlobalData) -> bool {
        (data.0)(&client)
    }
}

impl<D> Dispatch<ZglobalMenuBridgeV1, (), D> for GlobalMenuState
where
    D: Dispatch<ZglobalMenuBridgeV1, ()> + GlobalMenuHandler + 'static,
{
    fn request(
        state: &mut D,
        _: &Client,
        resource: &ZglobalMenuBridgeV1,
        request: zglobal_menu_bridge_v1::Request,
        _: &(),
        _: &DisplayHandle,
        _: &mut DataInit<'_, D>,
    ) {
        if let zglobal_menu_bridge_v1::Request::GetSnapshot = request {
            let menus = state.global_menu_state();
            menus.refresh();
            send_snapshot(resource, menus.serial, &menus.published());
        }
    }
    fn destroyed(state: &mut D, _: ClientId, resource: &ZglobalMenuBridgeV1, _: &()) {
        let menus = state.global_menu_state();
        menus.bridges.retain(|bridge| bridge != resource);
        menus.refresh();
    }
}

impl<D> GlobalDispatch<OrgKdeKwinAppmenuManager, (), D> for GlobalMenuState
where
    D: GlobalDispatch<OrgKdeKwinAppmenuManager, ()>
        + Dispatch<OrgKdeKwinAppmenuManager, ()>
        + 'static,
{
    fn bind(
        _: &mut D,
        _: &DisplayHandle,
        _: &Client,
        resource: New<OrgKdeKwinAppmenuManager>,
        _: &(),
        init: &mut DataInit<'_, D>,
    ) {
        init.init(resource, ());
    }
}

impl<D> Dispatch<OrgKdeKwinAppmenuManager, (), D> for GlobalMenuState
where
    D: Dispatch<OrgKdeKwinAppmenuManager, ()>
        + Dispatch<OrgKdeKwinAppmenu, SurfaceResourceData>
        + GlobalMenuHandler
        + 'static,
{
    fn request(
        state: &mut D,
        client: &Client,
        resource: &OrgKdeKwinAppmenuManager,
        request: org_kde_kwin_appmenu_manager::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, D>,
    ) {
        if let org_kde_kwin_appmenu_manager::Request::Create { id, surface } = request {
            if surface.client().as_ref() != Some(client) {
                resource.post_error(0u32, "Surface belongs to another client");
                return;
            }
            let data = match state.global_menu_state().resource_data(&surface) {
                Ok(data) => data,
                Err(error) => {
                    init.post_error(id, 0u32, error);
                    return;
                }
            };
            init.init(id, data);
        }
    }
}

impl<D> Dispatch<OrgKdeKwinAppmenu, SurfaceResourceData, D> for GlobalMenuState
where
    D: Dispatch<OrgKdeKwinAppmenu, SurfaceResourceData> + GlobalMenuHandler + 'static,
{
    fn request(
        state: &mut D,
        _: &Client,
        resource: &OrgKdeKwinAppmenu,
        request: org_kde_kwin_appmenu::Request,
        data: &SurfaceResourceData,
        _: &DisplayHandle,
        _: &mut DataInit<'_, D>,
    ) {
        if let org_kde_kwin_appmenu::Request::SetAddress {
            service_name,
            object_path,
        } = request
        {
            let menus = state.global_menu_state();
            if menus
                .registry
                .set_dbusmenu(data.key, &service_name, &object_path)
                .is_ok()
            {
                if let Some(record) = menus.surfaces.get_mut(&data.surface.id()) {
                    record.dbus_owner = Some(resource.id());
                }
                menus.refresh();
            }
        }
    }
    fn destroyed(
        state: &mut D,
        _: ClientId,
        resource: &OrgKdeKwinAppmenu,
        data: &SurfaceResourceData,
    ) {
        let menus = state.global_menu_state();
        if menus
            .surfaces
            .get(&data.surface.id())
            .is_some_and(|r| r.dbus_owner.as_ref() == Some(&resource.id()))
        {
            menus.registry.clear_dbusmenu(data.key);
            menus.refresh();
        }
    }
}

impl<D> GlobalDispatch<GtkShell1, (), D> for GlobalMenuState
where
    D: GlobalDispatch<GtkShell1, ()> + Dispatch<GtkShell1, ()> + GlobalMenuHandler + 'static,
{
    fn bind(
        state: &mut D,
        _: &DisplayHandle,
        _: &Client,
        resource: New<GtkShell1>,
        _: &(),
        init: &mut DataInit<'_, D>,
    ) {
        let shell = init.init(resource, ());
        let menus = state.global_menu_state();
        shell.capabilities(menus.capabilities);
        menus.gtk_shells.push(shell);
    }
}

impl<D> Dispatch<GtkShell1, (), D> for GlobalMenuState
where
    D: Dispatch<GtkShell1, ()>
        + Dispatch<GtkSurface1, SurfaceResourceData>
        + GlobalMenuHandler
        + 'static,
{
    fn request(
        state: &mut D,
        client: &Client,
        resource: &GtkShell1,
        request: gtk_shell1::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, D>,
    ) {
        if let gtk_shell1::Request::GetGtkSurface {
            gtk_surface,
            surface,
        } = request
        {
            if surface.client().as_ref() != Some(client) {
                resource.post_error(0u32, "Surface belongs to another client");
                return;
            }
            let data = match state.global_menu_state().resource_data(&surface) {
                Ok(data) => data,
                Err(error) => {
                    init.post_error(gtk_surface, 0u32, error);
                    return;
                }
            };
            init.init(gtk_surface, data);
        }
        // Other version-1 requests are advisory startup, bell and presentation
        // hints. This extension deliberately does not grant activation privileges.
    }
}

impl<D> Dispatch<GtkSurface1, SurfaceResourceData, D> for GlobalMenuState
where
    D: Dispatch<GtkSurface1, SurfaceResourceData> + GlobalMenuHandler + 'static,
{
    fn request(
        state: &mut D,
        _: &Client,
        resource: &GtkSurface1,
        request: gtk_surface1::Request,
        data: &SurfaceResourceData,
        _: &DisplayHandle,
        _: &mut DataInit<'_, D>,
    ) {
        if let gtk_surface1::Request::SetDbusProperties {
            unique_bus_name,
            menubar_path,
            app_menu_path,
            application_object_path,
            window_object_path,
            ..
        } = request
        {
            let address = GtkAddress {
                bus_name: unique_bus_name.unwrap_or_default(),
                menubar_path: menubar_path.unwrap_or_default(),
                app_menu_path: app_menu_path.unwrap_or_default(),
                application_path: application_object_path.unwrap_or_default(),
                window_path: window_object_path.unwrap_or_default(),
            };
            let menus = state.global_menu_state();
            if menus.registry.set_gtk(data.key, address).is_ok() {
                if let Some(record) = menus.surfaces.get_mut(&data.surface.id()) {
                    record.gtk_owner = Some(resource.id());
                }
                menus.refresh();
            }
        }
    }
    fn destroyed(state: &mut D, _: ClientId, resource: &GtkSurface1, data: &SurfaceResourceData) {
        let menus = state.global_menu_state();
        if menus
            .surfaces
            .get(&data.surface.id())
            .is_some_and(|r| r.gtk_owner.as_ref() == Some(&resource.id()))
        {
            menus.registry.clear_gtk(data.key);
            menus.refresh();
        }
    }
}

#[macro_export]
macro_rules! delegate_global_menu {
    ($ty:ty) => {
        $crate::wayland_server::delegate_global_dispatch!($ty: [$crate::protocols::server::bridge::zglobal_menu_bridge_v1::ZglobalMenuBridgeV1: $crate::BridgeGlobalData] => $crate::GlobalMenuState);
        $crate::wayland_server::delegate_dispatch!($ty: [$crate::protocols::server::bridge::zglobal_menu_bridge_v1::ZglobalMenuBridgeV1: ()] => $crate::GlobalMenuState);
        $crate::wayland_server::delegate_global_dispatch!($ty: [$crate::protocols::server::appmenu::org_kde_kwin_appmenu_manager::OrgKdeKwinAppmenuManager: ()] => $crate::GlobalMenuState);
        $crate::wayland_server::delegate_dispatch!($ty: [$crate::protocols::server::appmenu::org_kde_kwin_appmenu_manager::OrgKdeKwinAppmenuManager: ()] => $crate::GlobalMenuState);
        $crate::wayland_server::delegate_dispatch!($ty: [$crate::protocols::server::appmenu::org_kde_kwin_appmenu::OrgKdeKwinAppmenu: $crate::SurfaceResourceData] => $crate::GlobalMenuState);
        $crate::wayland_server::delegate_global_dispatch!($ty: [$crate::protocols::server::gtk::gtk_shell1::GtkShell1: ()] => $crate::GlobalMenuState);
        $crate::wayland_server::delegate_dispatch!($ty: [$crate::protocols::server::gtk::gtk_shell1::GtkShell1: ()] => $crate::GlobalMenuState);
        $crate::wayland_server::delegate_dispatch!($ty: [$crate::protocols::server::gtk::gtk_surface1::GtkSurface1: $crate::SurfaceResourceData] => $crate::GlobalMenuState);
    };
}
