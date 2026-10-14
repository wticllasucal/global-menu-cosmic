// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    bridge::{BridgeStatus, monitor},
    dbus::MenuBackend,
    model::{MenuAction, MenuNode, WindowSnapshot},
};
use futures_util::StreamExt;
use tokio::sync::{mpsc, watch};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum MenuStatus {
    #[default]
    MissingBridge,
    Idle,
    Loading,
    Unavailable,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Default)]
pub struct UiState {
    pub status: MenuStatus,
    pub detail: String,
    pub snapshot: Option<WindowSnapshot>,
    pub nodes: Vec<MenuNode>,
    pub generation: u64,
}

impl UiState {
    pub fn node_at(&self, generation: u64, path: &[usize]) -> Option<&MenuNode> {
        if generation != self.generation || self.status != MenuStatus::Ready {
            return None;
        }
        let mut nodes = &self.nodes;
        let mut found = None;
        for index in path {
            let node = nodes.get(*index)?;
            found = Some(node);
            nodes = &node.children;
        }
        found
    }

    pub fn select(&mut self, snapshot: WindowSnapshot) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.nodes.clear();
        self.detail.clear();
        self.status = if snapshot.window.is_none() {
            MenuStatus::Idle
        } else {
            MenuStatus::Loading
        };
        self.snapshot = Some(snapshot);
        self.generation
    }

    pub fn disconnect(&mut self, reason: String) {
        self.generation = self.generation.wrapping_add(1);
        self.status = MenuStatus::MissingBridge;
        self.detail = reason;
        self.nodes.clear();
        self.snapshot = None;
    }

    pub fn loaded(&mut self, generation: u64, result: Result<Vec<MenuNode>, String>) {
        if generation != self.generation {
            return;
        }
        match result {
            Ok(nodes) => {
                self.nodes = nodes;
                self.status = if self.snapshot.as_ref().is_none_or(|s| s.window.is_none()) {
                    MenuStatus::Idle
                } else if self.nodes.iter().any(|n| n.visible && !n.separator) {
                    MenuStatus::Ready
                } else {
                    MenuStatus::Unavailable
                };
                self.detail.clear();
            }
            Err(error) => {
                self.status = MenuStatus::Failed;
                self.detail = error;
                self.nodes.clear();
            }
        }
    }
}

#[derive(Clone, Debug)]
pub enum ControllerEvent {
    Snapshot(WindowSnapshot),
    Menus {
        generation: u64,
        result: Result<Vec<MenuNode>, String>,
    },
    Disconnected(String),
    ActionResult {
        generation: u64,
        error: Option<String>,
    },
}

#[derive(Clone, Debug)]
pub enum BackendCommand {
    Open { generation: u64, action: MenuAction },
    Activate { generation: u64, action: MenuAction },
    Close { action: MenuAction },
    Retry,
}

pub async fn run(events: mpsc::Sender<ControllerEvent>, commands: mpsc::Receiver<BackendCommand>) {
    run_with_bridge(events, commands, monitor()).await;
}

pub async fn run_with_bridge(
    events: mpsc::Sender<ControllerEvent>,
    mut commands: mpsc::Receiver<BackendCommand>,
    mut bridge: watch::Receiver<BridgeStatus>,
) {
    // Mirror UI generations, including disconnects; never reuse a wire serial
    // after reconnection for an asynchronous menu/action result.
    let mut generation = 0u64;
    loop {
        let status = bridge.borrow_and_update().clone();
        match status {
            BridgeStatus::Disconnected(reason) => {
                generation = generation.wrapping_add(1);
                if events
                    .send(ControllerEvent::Disconnected(reason))
                    .await
                    .is_err()
                {
                    return;
                }
                if bridge.changed().await.is_err() {
                    return;
                }
                continue;
            }
            BridgeStatus::Snapshot(_) => {}
        }
        let mut backend = match MenuBackend::connect().await {
            Ok(backend) => backend,
            Err(error) => {
                generation = generation.wrapping_add(1);
                let _ = events
                    .send(ControllerEvent::Disconnected(format!(
                        "Bus de sesión: {error}"
                    )))
                    .await;
                tokio::select! { _ = tokio::time::sleep(std::time::Duration::from_secs(3)) => {}, _ = events.closed() => return }
                continue;
            }
        };
        let mut updates = match backend.events().await {
            Ok(events) => events,
            Err(error) => {
                let _ = events
                    .send(ControllerEvent::Disconnected(error.to_string()))
                    .await;
                return;
            }
        };
        let mut reload = true;
        loop {
            if reload {
                let status = bridge.borrow_and_update().clone();
                let BridgeStatus::Snapshot(snapshot) = status else {
                    break;
                };
                generation = generation.wrapping_add(1);
                if events
                    .send(ControllerEvent::Snapshot(snapshot.clone()))
                    .await
                    .is_err()
                {
                    return;
                }
                let result = tokio::select! {
                    biased;
                    _ = events.closed() => return,
                    changed = bridge.changed() => { if changed.is_err() { return; } continue; },
                    result = backend.load(&snapshot) => result.map_err(|error| format!("{error:#}")),
                };
                if events
                    .send(ControllerEvent::Menus { generation, result })
                    .await
                    .is_err()
                {
                    return;
                }
                reload = false;
            }
            tokio::select! {
                biased;
                _ = events.closed() => return,
                changed = bridge.changed() => { if changed.is_err() { return; } reload = true; },
                update = updates.next() => {
                    if update.is_none() { break; }
                    // Invalidate before dispatching any queued click from the old tree.
                    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
                    while let Some(Some(_)) = updates.next().now_or_never() {}
                    reload = true;
                }
                command = commands.recv() => {
                    let Some(command) = command else { return; };
                    let requested = match &command {
                        BackendCommand::Open { generation, .. } | BackendCommand::Activate { generation, .. } => *generation,
                        BackendCommand::Retry | BackendCommand::Close { .. } => generation,
                    };
                    if requested != generation {
                        let _ = events.send(ControllerEvent::ActionResult { generation: requested, error: Some("La ventana o el menú cambiaron; acción descartada".into()) }).await;
                        continue;
                    }
                    let result = match command {
                        BackendCommand::Open { action, .. } => { reload = true; backend.about_to_show(&action).await },
                        BackendCommand::Activate { action, .. } => backend.activate(&action).await,
                        BackendCommand::Close { action } => {
                            // Cleanup targets the original unique owner, even after a
                            // generation change, and must not erase an activation error.
                            let _ = backend.close_submenu(&action).await;
                            continue;
                        },
                        BackendCommand::Retry => { reload = true; Ok(()) },
                    };
                    let _ = events.send(ControllerEvent::ActionResult { generation, error: result.err().map(|error| format!("{error:#}")) }).await;
                }
            }
        }
    }
}

use futures_util::FutureExt;
