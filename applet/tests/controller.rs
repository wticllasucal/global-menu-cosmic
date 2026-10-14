use cosmic_global_menu::{
    bridge::BridgeStatus,
    controller::{self, BackendCommand, ControllerEvent, UiState},
    model::{DbusAddress, WindowInfo, WindowSnapshot},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, watch};
use zbus::{
    connection::Builder,
    zvariant::{OwnedValue, Structure, Value},
};

type Properties = HashMap<String, OwnedValue>;
type Calls = Arc<Mutex<Vec<i32>>>;
struct Exporter {
    calls: Calls,
    slow: bool,
}
#[zbus::interface(name = "com.canonical.dbusmenu")]
impl Exporter {
    async fn get_layout(
        &self,
        _id: i32,
        _depth: i32,
        _properties: Vec<String>,
    ) -> (u32, (i32, Properties, Vec<OwnedValue>)) {
        if self.slow {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        let props: Properties =
            HashMap::from([("label".into(), Value::from("Open").try_into().unwrap())]);
        (
            1,
            (
                0,
                HashMap::new(),
                vec![
                    Structure::from((7i32, props, Vec::<OwnedValue>::new()))
                        .try_into()
                        .unwrap(),
                ],
            ),
        )
    }
    fn event(&self, id: i32, _event: &str, _data: OwnedValue, _time: u32) {
        self.calls.lock().unwrap().push(id);
    }
}

struct Actor(tokio::task::JoinHandle<()>);
impl Drop for Actor {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn ready(events: &mut mpsc::Receiver<ControllerEvent>, state: &mut UiState) {
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            match events.recv().await.unwrap() {
                ControllerEvent::Snapshot(snapshot) => {
                    state.select(snapshot);
                }
                ControllerEvent::Disconnected(reason) => state.disconnect(reason),
                ControllerEvent::Menus { generation, result } => {
                    state.loaded(generation, result);
                    return;
                }
                _ => {}
            }
        }
    })
    .await
    .unwrap();
}

fn snapshot(bus: &zbus::Connection, id: u64) -> BridgeStatus {
    BridgeStatus::Snapshot(WindowSnapshot {
        serial: id as u32,
        window: Some(WindowInfo {
            id,
            ..Default::default()
        }),
        dbusmenu: Some(DbusAddress::new(bus.unique_name().unwrap().as_str(), "/Menu").unwrap()),
        gtk: None,
    })
}

#[tokio::test]
async fn old_window_command_is_not_executed_after_focus_change() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let bus = Builder::session()
        .unwrap()
        .serve_at(
            "/Menu",
            Exporter {
                calls: calls.clone(),
                slow: false,
            },
        )
        .unwrap()
        .build()
        .await
        .unwrap();
    let (bridge, receiver) = watch::channel(snapshot(&bus, 1));
    let (events, mut incoming) = mpsc::channel(32);
    let (commands, requests) = mpsc::channel(32);
    let _actor = Actor(tokio::spawn(controller::run_with_bridge(
        events, requests, receiver,
    )));
    let mut state = UiState::default();
    ready(&mut incoming, &mut state).await;
    let old = state.generation;
    let action = state.nodes[0].action.clone().unwrap();
    bridge.send(snapshot(&bus, 2)).unwrap();
    ready(&mut incoming, &mut state).await;
    commands
        .send(BackendCommand::Activate {
            generation: old,
            action: action.clone(),
        })
        .await
        .unwrap();
    commands
        .send(BackendCommand::Activate {
            generation: state.generation,
            action,
        })
        .await
        .unwrap();
    let results = tokio::time::timeout(Duration::from_secs(2), async {
        let mut results = Vec::new();
        while results.len() < 2 {
            if let Some(ControllerEvent::ActionResult { generation, error }) = incoming.recv().await
            {
                results.push((generation, error));
            }
        }
        results
    })
    .await
    .unwrap();
    assert_eq!(*calls.lock().unwrap(), vec![7]);
    assert!(
        results
            .iter()
            .any(|(generation, error)| *generation == old && error.is_some())
    );
    assert!(
        results
            .iter()
            .any(|(generation, error)| *generation == state.generation && error.is_none())
    );
}

#[tokio::test]
async fn slow_previous_window_load_is_cancelled_on_new_snapshot() {
    let slow = Builder::session()
        .unwrap()
        .serve_at(
            "/Menu",
            Exporter {
                calls: Default::default(),
                slow: true,
            },
        )
        .unwrap()
        .build()
        .await
        .unwrap();
    let fast = Builder::session()
        .unwrap()
        .serve_at(
            "/Menu",
            Exporter {
                calls: Default::default(),
                slow: false,
            },
        )
        .unwrap()
        .build()
        .await
        .unwrap();
    let (bridge, receiver) = watch::channel(snapshot(&slow, 1));
    let (events, mut incoming) = mpsc::channel(32);
    let (_commands, requests) = mpsc::channel(32);
    let _actor = Actor(tokio::spawn(controller::run_with_bridge(
        events, requests, receiver,
    )));
    let first = tokio::time::timeout(Duration::from_secs(2), incoming.recv())
        .await
        .unwrap()
        .unwrap();
    let mut state = UiState::default();
    if let ControllerEvent::Snapshot(snapshot) = first {
        state.select(snapshot);
    } else {
        panic!("{first:?}");
    }
    bridge.send(snapshot(&fast, 2)).unwrap();
    tokio::time::timeout(Duration::from_secs(1), ready(&mut incoming, &mut state))
        .await
        .unwrap();
    assert_eq!(
        state.snapshot.as_ref().unwrap().window.as_ref().unwrap().id,
        2
    );
    assert_eq!(
        state.nodes[0].action.as_ref().unwrap().address.bus_name,
        fast.unique_name().unwrap().as_str()
    );
}

#[tokio::test]
async fn owner_loss_clears_actions_without_exposing_its_replacement() {
    let original = Builder::session()
        .unwrap()
        .serve_at(
            "/Menu",
            Exporter {
                calls: Default::default(),
                slow: false,
            },
        )
        .unwrap()
        .build()
        .await
        .unwrap();
    original
        .request_name("test.GlobalMenuControllerOwner")
        .await
        .unwrap();
    let BridgeStatus::Snapshot(mut source) = snapshot(&original, 1) else {
        unreachable!()
    };
    source.dbusmenu.as_mut().unwrap().bus_name = "test.GlobalMenuControllerOwner".into();
    let (_bridge, receiver) = watch::channel(BridgeStatus::Snapshot(source));
    let (events, mut incoming) = mpsc::channel(32);
    let (_commands, requests) = mpsc::channel(32);
    let _actor = Actor(tokio::spawn(controller::run_with_bridge(
        events, requests, receiver,
    )));
    let mut state = UiState::default();
    ready(&mut incoming, &mut state).await;
    original.close().await.unwrap();
    let calls = Calls::default();
    let replacement = Builder::session()
        .unwrap()
        .serve_at(
            "/Menu",
            Exporter {
                calls: calls.clone(),
                slow: false,
            },
        )
        .unwrap()
        .build()
        .await
        .unwrap();
    replacement
        .request_name("test.GlobalMenuControllerOwner")
        .await
        .unwrap();
    ready(&mut incoming, &mut state).await;
    assert!(state.nodes.is_empty());
    assert_eq!(state.status, controller::MenuStatus::Failed);
    assert!(calls.lock().unwrap().is_empty());
}

struct GatedExporter {
    calls: Calls,
    changed: Arc<AtomicBool>,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}
#[zbus::interface(name = "com.canonical.dbusmenu")]
impl GatedExporter {
    fn get_layout(
        &self,
        _id: i32,
        _depth: i32,
        _properties: Vec<String>,
    ) -> (u32, (i32, Properties, Vec<OwnedValue>)) {
        let children = [1i32, 2]
            .into_iter()
            .map(|id| {
                let mut props: Properties =
                    HashMap::from([("label".into(), Value::from("Action").try_into().unwrap())]);
                props.insert(
                    "enabled".into(),
                    (id == 1 || !self.changed.load(Ordering::SeqCst)).into(),
                );
                Structure::from((id, props, Vec::<OwnedValue>::new()))
                    .try_into()
                    .unwrap()
            })
            .collect();
        (1, (0, HashMap::new(), children))
    }
    async fn event(&self, id: i32, _event: &str, _data: OwnedValue, _time: u32) {
        self.calls.lock().unwrap().push(id);
        if id == 1 {
            self.entered.notify_one();
            self.release.notified().await;
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn pending_invalidation_precedes_a_queued_click() {
    let calls = Calls::default();
    let changed = Arc::new(AtomicBool::new(false));
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let bus = Builder::session()
        .unwrap()
        .serve_at(
            "/Menu",
            GatedExporter {
                calls: calls.clone(),
                changed: changed.clone(),
                entered: entered.clone(),
                release: release.clone(),
            },
        )
        .unwrap()
        .build()
        .await
        .unwrap();
    let (_bridge, receiver) = watch::channel(snapshot(&bus, 1));
    let (events, mut incoming) = mpsc::channel(32);
    let (commands, requests) = mpsc::channel(32);
    let _actor = Actor(tokio::spawn(controller::run_with_bridge(
        events, requests, receiver,
    )));
    let mut state = UiState::default();
    ready(&mut incoming, &mut state).await;
    let generation = state.generation;
    commands
        .send(BackendCommand::Activate {
            generation,
            action: state.nodes[0].action.clone().unwrap(),
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    changed.store(true, Ordering::SeqCst);
    bus.emit_signal(
        None::<&str>,
        "/Menu",
        "com.canonical.dbusmenu",
        "LayoutUpdated",
        &(2u32, 0i32),
    )
    .await
    .unwrap();
    // Allow the bus reader to enqueue the signal while Event is still gated.
    tokio::time::sleep(Duration::from_millis(100)).await;
    commands
        .send(BackendCommand::Activate {
            generation,
            action: state.nodes[1].action.clone().unwrap(),
        })
        .await
        .unwrap();
    release.notify_one();
    let results = tokio::time::timeout(Duration::from_secs(2), async {
        let mut results = Vec::new();
        while results.len() < 2 {
            if let Some(ControllerEvent::ActionResult { error, .. }) = incoming.recv().await {
                results.push(error);
            }
        }
        results
    })
    .await
    .unwrap();
    assert_eq!(
        *calls.lock().unwrap(),
        vec![1],
        "The now-disabled action must not receive clicked"
    );
    assert!(results[1].is_some());
}
