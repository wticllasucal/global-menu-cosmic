// SPDX-License-Identifier: GPL-3.0-only
use crate::model::{BridgeEvent, GtkAddress, SnapshotAssembler, WindowInfo, WindowSnapshot};
use cosmic_global_menu_bridge::protocols::client::bridge::zglobal_menu_bridge_v1::{
    self, ZglobalMenuBridgeV1,
};
use std::{
    os::{
        fd::{FromRawFd, OwnedFd},
        unix::net::UnixStream,
    },
    path::PathBuf,
    thread,
    time::Duration,
};
use tokio::sync::watch;
use wayland_client::{
    Connection, Dispatch, QueueHandle,
    globals::{GlobalListContents, registry_queue_init},
    protocol::wl_registry,
};

#[derive(Clone, Debug)]
pub enum BridgeStatus {
    Snapshot(WindowSnapshot),
    Disconnected(String),
}

pub fn monitor() -> watch::Receiver<BridgeStatus> {
    let (sender, receiver) = watch::channel(BridgeStatus::Disconnected(
        "Esperando el compositor compatible".into(),
    ));
    thread::spawn(move || {
        // The GUI uses WAYLAND_SOCKET (COSMIC panel's proxy). This *separate*
        // connection consumes the panel-provided privileged fd, if present.
        // applet-token is deliberately not enabled: it would consume the same fd.
        let privileged = std::env::var("X_PRIVILEGED_WAYLAND_SOCKET")
            .ok()
            .and_then(|fd| fd.parse::<i32>().ok())
            .filter(|fd| *fd >= 3)
            .map(|fd| {
                // SAFETY: the COSMIC launcher transfers this descriptor to the applet;
                // this is its sole owner and we never re-read it on a retry.
                let owned = unsafe { OwnedFd::from_raw_fd(fd) };
                UnixStream::from(owned)
            });
        let mut first = privileged;
        while !sender.is_closed() {
            let result = first
                .take()
                .map(Ok)
                .unwrap_or_else(connect_direct)
                .and_then(|socket| Connection::from_socket(socket).map_err(|e| e.to_string()))
                .and_then(|connection| run_connection(connection, &sender));
            if let Err(error) = result {
                let _ = sender.send(BridgeStatus::Disconnected(error));
            }
            thread::sleep(Duration::from_secs(3));
        }
    });
    receiver
}

fn connect_direct() -> Result<UnixStream, String> {
    let display = std::env::var_os("WAYLAND_DISPLAY").ok_or("WAYLAND_DISPLAY no disponible")?;
    let mut path = PathBuf::from(display);
    if !path.is_absolute() {
        let runtime = std::env::var_os("XDG_RUNTIME_DIR").ok_or("XDG_RUNTIME_DIR no disponible")?;
        path = PathBuf::from(runtime).join(path);
    }
    UnixStream::connect(path).map_err(|e| format!("No se puede conectar con Wayland: {e}"))
}

pub fn run_connection(
    connection: Connection,
    sender: &watch::Sender<BridgeStatus>,
) -> Result<(), String> {
    let (globals, mut queue) =
        registry_queue_init::<ClientState>(&connection).map_err(|e| e.to_string())?;
    let bridge: ZglobalMenuBridgeV1 = globals.bind(&queue.handle(), 1..=1, ()).map_err(|_| {
        "Falta el puente de menú global. Aplica el parche compatible de cosmic-comp".to_string()
    })?;
    let mut state = ClientState {
        assembler: SnapshotAssembler::default(),
        sender: sender.clone(),
        global_name: globals.contents().with_list(|list| {
            list.iter()
                .find(|g| g.interface == "zglobal_menu_bridge_v1")
                .map(|g| g.name)
        }),
    };
    bridge.get_snapshot();
    queue.roundtrip(&mut state).map_err(|e| e.to_string())?;
    while !sender.is_closed() {
        queue
            .blocking_dispatch(&mut state)
            .map_err(|e| e.to_string())?;
        if state.global_name.is_none() {
            return Err("El puente fue retirado del compositor".into());
        }
    }
    bridge.destroy();
    let _ = connection.flush();
    Ok(())
}

struct ClientState {
    assembler: SnapshotAssembler,
    sender: watch::Sender<BridgeStatus>,
    global_name: Option<u32>,
}
impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for ClientState {
    fn event(
        state: &mut Self,
        _: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::GlobalRemove { name } = event {
            if state.global_name == Some(name) {
                state.global_name = None;
            }
        }
    }
}
impl Dispatch<ZglobalMenuBridgeV1, ()> for ClientState {
    fn event(
        state: &mut Self,
        _: &ZglobalMenuBridgeV1,
        event: zglobal_menu_bridge_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        use zglobal_menu_bridge_v1::Event;
        let event = match event {
            Event::Active {
                serial,
                window_id,
                app_id,
                title,
                pid,
                xid,
            } => {
                let Ok(id) = window_id.parse() else {
                    return;
                };
                BridgeEvent::Active(
                    serial,
                    WindowInfo {
                        id,
                        app_id,
                        title,
                        pid,
                        xid,
                    },
                )
            }
            Event::Clear { serial } => BridgeEvent::Clear(serial),
            Event::Dbusmenu {
                serial,
                bus_name,
                object_path,
            } => BridgeEvent::DbusMenu(serial, bus_name, object_path),
            Event::GtkMenu {
                serial,
                bus_name,
                menubar_path,
                app_menu_path,
                application_path,
                window_path,
            } => BridgeEvent::GtkMenu(
                serial,
                GtkAddress {
                    bus_name,
                    menubar_path,
                    app_menu_path,
                    application_path,
                    window_path,
                },
            ),
            Event::Done { serial } => BridgeEvent::Done(serial),
            _ => return,
        };
        if let Some(snapshot) = state.assembler.push(event) {
            let _ = state.sender.send(BridgeStatus::Snapshot(snapshot));
        }
    }
}
