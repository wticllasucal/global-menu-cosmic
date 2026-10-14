use cosmic_global_menu_bridge::protocols::client::{
    appmenu::{org_kde_kwin_appmenu, org_kde_kwin_appmenu_manager},
    bridge::zglobal_menu_bridge_v1,
    gtk::{gtk_shell1, gtk_surface1},
};
use cosmic_global_menu_bridge::{ActiveWindow, GlobalMenuHandler, GlobalMenuState, WindowInfo};
use std::{
    os::unix::net::UnixStream,
    sync::{Arc, mpsc},
    thread,
    time::Duration,
};
use wayland_client::{
    Connection, Dispatch, QueueHandle,
    globals::{GlobalListContents, registry_queue_init},
    protocol::{wl_compositor, wl_registry, wl_surface},
};
use wayland_server::{Client, DataInit, Display, DisplayHandle, GlobalDispatch, New};

enum Command {
    Focus(Option<usize>, mpsc::Sender<()>),
    Stop,
}

struct Server {
    menus: GlobalMenuState,
    surfaces: Vec<wayland_server::protocol::wl_surface::WlSurface>,
}
impl GlobalMenuHandler for Server {
    fn global_menu_state(&mut self) -> &mut GlobalMenuState {
        &mut self.menus
    }
}
cosmic_global_menu_bridge::delegate_global_menu!(Server);

impl GlobalDispatch<wayland_server::protocol::wl_compositor::WlCompositor, ()> for Server {
    fn bind(
        _: &mut Self,
        _: &DisplayHandle,
        _: &Client,
        resource: New<wayland_server::protocol::wl_compositor::WlCompositor>,
        _: &(),
        init: &mut DataInit<'_, Self>,
    ) {
        init.init(resource, ());
    }
}
impl wayland_server::Dispatch<wayland_server::protocol::wl_compositor::WlCompositor, ()>
    for Server
{
    fn request(
        state: &mut Self,
        _: &Client,
        _: &wayland_server::protocol::wl_compositor::WlCompositor,
        request: wayland_server::protocol::wl_compositor::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        match request {
            wayland_server::protocol::wl_compositor::Request::CreateSurface { id } => {
                state.surfaces.push(init.init(id, ()))
            }
            wayland_server::protocol::wl_compositor::Request::CreateRegion { id } => {
                init.init(id, ());
            }
            _ => {}
        }
    }
}
impl wayland_server::Dispatch<wayland_server::protocol::wl_surface::WlSurface, ()> for Server {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &wayland_server::protocol::wl_surface::WlSurface,
        _: wayland_server::protocol::wl_surface::Request,
        _: &(),
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
    }
}
impl wayland_server::Dispatch<wayland_server::protocol::wl_region::WlRegion, ()> for Server {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &wayland_server::protocol::wl_region::WlRegion,
        _: wayland_server::protocol::wl_region::Request,
        _: &(),
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
    }
}

struct TestServer {
    commands: mpsc::Sender<Command>,
    thread: Option<thread::JoinHandle<()>>,
}
impl TestServer {
    fn start(allow_bridge: bool) -> (Self, Connection) {
        let (client_socket, server_socket) = UnixStream::pair().unwrap();
        let (commands, receiver) = mpsc::channel();
        let handle = thread::spawn(move || {
            let mut display = Display::<Server>::new().unwrap();
            let mut dh = display.handle();
            dh.create_global::<Server, wayland_server::protocol::wl_compositor::WlCompositor, _>(
                1,
                (),
            );
            let mut state = Server {
                menus: GlobalMenuState::new::<Server>(&dh, move |_| allow_bridge),
                surfaces: Vec::new(),
            };
            dh.insert_client(server_socket, Arc::new(())).unwrap();
            loop {
                while let Ok(command) = receiver.try_recv() {
                    match command {
                        Command::Stop => return,
                        Command::Focus(index, reply) => {
                            let active = index.map(|i| {
                                let surface = state.surfaces[i].clone();
                                let key = state.menus.surface_key(&surface).unwrap();
                                ActiveWindow {
                                    info: WindowInfo {
                                        id: key,
                                        app_id: "test.editor".into(),
                                        title: format!("window {i}"),
                                        pid: 10,
                                        xid: 0,
                                    },
                                    surface: Some(surface),
                                }
                            });
                            state.menus.set_active(active);
                            state.menus.refresh();
                            display.flush_clients().unwrap();
                            reply.send(()).unwrap();
                        }
                    }
                }
                display.dispatch_clients(&mut state).unwrap();
                state.menus.refresh();
                display.flush_clients().unwrap();
                thread::sleep(Duration::from_millis(1));
            }
        });
        (
            Self {
                commands,
                thread: Some(handle),
            },
            Connection::from_socket(client_socket).unwrap(),
        )
    }
    fn focus(&self, index: Option<usize>) {
        let (reply, rx) = mpsc::channel();
        self.commands.send(Command::Focus(index, reply)).unwrap();
        rx.recv_timeout(Duration::from_secs(3)).unwrap();
    }
}
impl Drop for TestServer {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Stop);
        if let Some(handle) = self.thread.take() {
            handle.join().unwrap();
        }
    }
}

#[derive(Default)]
struct Consumer {
    path: Option<String>,
    gtk_path: Option<String>,
    capabilities: u32,
    pending_path: Option<String>,
    pending_gtk: Option<String>,
}
impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for Consumer {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<wl_compositor::WlCompositor, ()> for Consumer {
    fn event(
        _: &mut Self,
        _: &wl_compositor::WlCompositor,
        _: wl_compositor::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<wl_surface::WlSurface, ()> for Consumer {
    fn event(
        _: &mut Self,
        _: &wl_surface::WlSurface,
        _: wl_surface::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<org_kde_kwin_appmenu_manager::OrgKdeKwinAppmenuManager, ()> for Consumer {
    fn event(
        _: &mut Self,
        _: &org_kde_kwin_appmenu_manager::OrgKdeKwinAppmenuManager,
        _: org_kde_kwin_appmenu_manager::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<org_kde_kwin_appmenu::OrgKdeKwinAppmenu, ()> for Consumer {
    fn event(
        _: &mut Self,
        _: &org_kde_kwin_appmenu::OrgKdeKwinAppmenu,
        _: org_kde_kwin_appmenu::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<gtk_shell1::GtkShell1, ()> for Consumer {
    fn event(
        state: &mut Self,
        _: &gtk_shell1::GtkShell1,
        event: gtk_shell1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let gtk_shell1::Event::Capabilities { capabilities } = event {
            state.capabilities = capabilities;
        }
    }
}
impl Dispatch<gtk_surface1::GtkSurface1, ()> for Consumer {
    fn event(
        _: &mut Self,
        _: &gtk_surface1::GtkSurface1,
        _: gtk_surface1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
impl Dispatch<zglobal_menu_bridge_v1::ZglobalMenuBridgeV1, ()> for Consumer {
    fn event(
        state: &mut Self,
        _: &zglobal_menu_bridge_v1::ZglobalMenuBridgeV1,
        event: zglobal_menu_bridge_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        use zglobal_menu_bridge_v1::Event;
        match event {
            Event::Active { .. } | Event::Clear { .. } => {
                state.pending_path = None;
                state.pending_gtk = None;
            }
            Event::Dbusmenu { object_path, .. } => state.pending_path = Some(object_path),
            Event::GtkMenu { menubar_path, .. } => state.pending_gtk = Some(menubar_path),
            Event::Done { .. } => {
                state.path = state.pending_path.clone();
                state.gtk_path = state.pending_gtk.clone();
            }
            _ => {}
        }
    }
}

#[test]
fn native_wayland_addresses_follow_the_focused_surface() {
    let (server, connection) = TestServer::start(true);
    let (globals, mut queue) = registry_queue_init::<Consumer>(&connection).unwrap();
    let qh = queue.handle();
    let compositor: wl_compositor::WlCompositor = globals.bind(&qh, 1..=1, ()).unwrap();
    let manager: org_kde_kwin_appmenu_manager::OrgKdeKwinAppmenuManager =
        globals.bind(&qh, 1..=2, ()).unwrap();
    let _bridge: zglobal_menu_bridge_v1::ZglobalMenuBridgeV1 =
        globals.bind(&qh, 1..=1, ()).unwrap();
    let first = compositor.create_surface(&qh, ());
    let second = compositor.create_surface(&qh, ());
    let first_menu = manager.create(&first, &qh, ());
    let second_menu = manager.create(&second, &qh, ());
    first_menu.set_address(":1.20".into(), "/Menu/one".into());
    second_menu.set_address(":1.20".into(), "/Menu/two".into());
    let mut state = Consumer::default();
    queue.roundtrip(&mut state).unwrap();
    server.focus(Some(0));
    queue.roundtrip(&mut state).unwrap();
    assert_eq!(state.path.as_deref(), Some("/Menu/one"));
    server.focus(Some(1));
    queue.roundtrip(&mut state).unwrap();
    assert_eq!(state.path.as_deref(), Some("/Menu/two"));
    second.destroy();
    queue.roundtrip(&mut state).unwrap();
    queue.roundtrip(&mut state).unwrap();
    assert!(state.path.is_none());
}

#[test]
fn gtk_exports_and_capabilities_follow_the_consumer_lifetime() {
    let (server, connection) = TestServer::start(true);
    let (globals, mut queue) = registry_queue_init::<Consumer>(&connection).unwrap();
    let qh = queue.handle();
    let compositor: wl_compositor::WlCompositor = globals.bind(&qh, 1..=1, ()).unwrap();
    let gtk: gtk_shell1::GtkShell1 = globals.bind(&qh, 1..=1, ()).unwrap();
    let mut state = Consumer::default();
    queue.roundtrip(&mut state).unwrap();
    assert_eq!(state.capabilities, 0);
    let bridge: zglobal_menu_bridge_v1::ZglobalMenuBridgeV1 = globals.bind(&qh, 1..=1, ()).unwrap();
    let surface = compositor.create_surface(&qh, ());
    let metadata = gtk.get_gtk_surface(&surface, &qh, ());
    metadata.set_dbus_properties(
        Some("test.editor".into()),
        Some("/AppMenu".into()),
        Some("/Menubar".into()),
        Some("/Window".into()),
        Some("/Application".into()),
        Some(":1.20".into()),
    );
    queue.roundtrip(&mut state).unwrap();
    assert_ne!(state.capabilities, 0);
    server.focus(Some(0));
    queue.roundtrip(&mut state).unwrap();
    assert_eq!(state.gtk_path.as_deref(), Some("/Menubar"));
    bridge.destroy();
    queue.roundtrip(&mut state).unwrap();
    assert_eq!(state.capabilities, 0);
}

#[test]
fn restricted_clients_cannot_see_the_bridge() {
    let (_server, connection) = TestServer::start(false);
    let (globals, queue) = registry_queue_init::<Consumer>(&connection).unwrap();
    let result: Result<zglobal_menu_bridge_v1::ZglobalMenuBridgeV1, _> =
        globals.bind(&queue.handle(), 1..=1, ());
    assert!(result.is_err());
}
