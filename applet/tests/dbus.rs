use cosmic_global_menu::{
    dbus::MenuBackend,
    model::{DbusAddress, GtkAddress, WindowInfo, WindowSnapshot},
};
use futures_util::StreamExt;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use zbus::{
    Connection,
    connection::Builder,
    zvariant::{OwnedObjectPath, OwnedValue, Signature, Structure, Value},
};

type Properties = HashMap<String, OwnedValue>;
type Layout = (i32, Properties, Vec<OwnedValue>);
type Calls = Arc<Mutex<Vec<(i32, String)>>>;

fn text(value: &str) -> OwnedValue {
    Value::from(value.to_owned()).try_into().unwrap()
}
fn node(id: i32, props: Properties, children: Vec<OwnedValue>) -> OwnedValue {
    Structure::from((id, props, children)).try_into().unwrap()
}
fn props(label: &str) -> Properties {
    HashMap::from([("label".into(), text(label))])
}

struct Exporter {
    calls: Calls,
    oversized: bool,
    slow: bool,
}
#[zbus::interface(name = "com.canonical.dbusmenu")]
impl Exporter {
    async fn get_layout(&self, _parent: i32, _depth: i32, _names: Vec<String>) -> (u32, Layout) {
        if self.slow {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
        let count = if self.oversized { 401 } else { 1 };
        let entries = (0..count)
            .map(|n| {
                let mut disabled = props("_Unavailable");
                disabled.insert("enabled".into(), false.into());
                let mut checked = props("_Checked");
                checked.insert("toggle-type".into(), text("checkmark"));
                checked.insert("toggle-state".into(), 1i32.into());
                node(
                    10 + n,
                    props("_File"),
                    vec![
                        node(20, props("_Open"), vec![]),
                        node(21, disabled, vec![]),
                        node(22, checked, vec![]),
                        node(
                            23,
                            HashMap::from([("type".into(), text("separator"))]),
                            vec![],
                        ),
                        node(
                            24,
                            HashMap::from([
                                ("label".into(), text("_Dynamic")),
                                ("children-display".into(), text("submenu")),
                            ]),
                            vec![],
                        ),
                        node(25, props("Save & Close"), vec![]),
                    ],
                )
            })
            .collect();
        (1, (0, HashMap::new(), entries))
    }
    fn about_to_show(&self, id: i32) -> bool {
        self.calls.lock().unwrap().push((id, "show".into()));
        false
    }
    fn event(&self, id: i32, event_id: &str, _data: OwnedValue, _timestamp: u32) {
        self.calls.lock().unwrap().push((id, event_id.into()));
    }
}

async fn exporter(oversized: bool, slow: bool) -> (Connection, Calls) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let connection = Builder::session()
        .unwrap()
        .serve_at(
            "/Menu",
            Exporter {
                calls: calls.clone(),
                oversized,
                slow,
            },
        )
        .unwrap()
        .build()
        .await
        .unwrap();
    (connection, calls)
}
fn snapshot(connection: &Connection) -> WindowSnapshot {
    WindowSnapshot {
        serial: 1,
        window: Some(WindowInfo {
            id: 1,
            ..Default::default()
        }),
        dbusmenu: Some(
            DbusAddress::new(connection.unique_name().unwrap().as_str(), "/Menu").unwrap(),
        ),
        gtk: None,
    }
}

#[tokio::test]
async fn dbusmenu_loads_real_tree_and_activates_original_owner() {
    let (connection, calls) = exporter(false, false).await;
    let mut backend = MenuBackend::connect().await.unwrap();
    let tree = backend.load(&snapshot(&connection)).await.unwrap();
    assert_eq!(tree[0].label, "File");
    assert_eq!(tree[0].children[0].label, "Open");
    assert!(!tree[0].children[1].enabled);
    assert_eq!(tree[0].children[2].checked, Some(true));
    assert!(tree[0].children[3].separator);
    assert!(
        tree[0].children[4].submenu,
        "An initially empty submenu must still open with AboutToShow"
    );
    backend
        .about_to_show(tree[0].action.as_ref().unwrap())
        .await
        .unwrap();
    backend
        .activate(tree[0].children[0].action.as_ref().unwrap())
        .await
        .unwrap();
    assert_eq!(
        *calls.lock().unwrap(),
        vec![(10, "show".into()), (20, "clicked".into())]
    );
    assert!(
        backend
            .activate(tree[0].children[1].action.as_ref().unwrap())
            .await
            .is_err()
    );
    assert!(
        backend
            .about_to_show(tree[0].children[1].action.as_ref().unwrap())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn oversized_tree_is_rejected() {
    let (connection, _) = exporter(true, false).await;
    let mut backend = MenuBackend::connect().await.unwrap();
    assert!(
        backend
            .load(&snapshot(&connection))
            .await
            .unwrap_err()
            .to_string()
            .contains("límite")
    );
}

#[tokio::test]
async fn literal_ampersand_is_preserved_in_menu_labels() {
    let (connection, _) = exporter(false, false).await;
    let mut backend = MenuBackend::connect().await.unwrap();
    let tree = backend.load(&snapshot(&connection)).await.unwrap();
    assert_eq!(tree[0].children[5].label, "Save & Close");
}

#[tokio::test]
async fn exporter_timeout_does_not_block_forever() {
    let (connection, _) = exporter(false, true).await;
    let mut backend = MenuBackend::connect().await.unwrap();
    let start = std::time::Instant::now();
    assert!(backend.load(&snapshot(&connection)).await.is_err());
    assert!(start.elapsed() < std::time::Duration::from_secs(4));
}

#[tokio::test]
async fn disappearing_exporter_is_not_replaced_by_new_owner() {
    let (connection, _) = exporter(false, false).await;
    connection
        .request_name("test.GlobalMenuExporter")
        .await
        .unwrap();
    let mut source = snapshot(&connection);
    source.dbusmenu.as_mut().unwrap().bus_name = "test.GlobalMenuExporter".into();
    let mut backend = MenuBackend::connect().await.unwrap();
    let tree = backend.load(&source).await.unwrap();
    connection.close().await.unwrap();
    let (replacement, calls) = exporter(false, false).await;
    replacement
        .request_name("test.GlobalMenuExporter")
        .await
        .unwrap();
    assert!(
        backend
            .activate(tree[0].children[0].action.as_ref().unwrap())
            .await
            .is_err()
    );
    assert!(calls.lock().unwrap().is_empty());
}

struct GtkMenus;
#[zbus::interface(name = "org.gtk.Menus")]
impl GtkMenus {
    fn start(&self, groups: Vec<u32>) -> Vec<(u32, u32, Vec<Properties>)> {
        assert_eq!(groups, vec![0]);
        let mut file = props("_File");
        file.insert(
            ":submenu".into(),
            Structure::from((0u32, 1u32)).try_into().unwrap(),
        );
        let mut item = props("_Mode");
        item.insert("action".into(), text("app.mode"));
        item.insert("target".into(), 42u32.into());
        vec![(0, 0, vec![file]), (0, 1, vec![item])]
    }
    fn end(&self, _groups: Vec<u32>) {}
}

struct HugeGtk;
#[zbus::interface(name = "org.gtk.Menus")]
impl HugeGtk {
    fn start(&self, _groups: Vec<u32>) -> Vec<(u32, u32, Vec<Properties>)> {
        (0..13)
            .map(|menu| (0, menu, (0..400).map(|_| props("item")).collect()))
            .collect()
    }
    fn end(&self, _groups: Vec<u32>) {}
}

#[tokio::test]
async fn gtk_budget_counts_unreferenced_menus_too() {
    let connection = Builder::session()
        .unwrap()
        .serve_at("/Menus", HugeGtk)
        .unwrap()
        .build()
        .await
        .unwrap();
    let source = WindowSnapshot {
        window: Some(WindowInfo::default()),
        gtk: Some(GtkAddress {
            bus_name: connection.unique_name().unwrap().to_string(),
            menubar_path: "/Menus".into(),
            ..Default::default()
        }),
        ..Default::default()
    };
    let mut backend = MenuBackend::connect().await.unwrap();
    assert!(backend.load(&source).await.is_err());
}

#[tokio::test]
async fn layout_update_signal_reaches_the_backend_event_stream() {
    let (connection, _) = exporter(false, false).await;
    let mut backend = MenuBackend::connect().await.unwrap();
    let mut events = backend.events().await.unwrap();
    backend.load(&snapshot(&connection)).await.unwrap();
    connection
        .emit_signal(
            None::<&str>,
            "/Menu",
            "com.canonical.dbusmenu",
            "LayoutUpdated",
            &(2u32, 0i32),
        )
        .await
        .unwrap();
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let event = events.next().await.unwrap();
            if event.message.header().member().unwrap().as_str() == "LayoutUpdated" {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        event.message.header().sender().unwrap().as_str(),
        connection.unique_name().unwrap().as_str()
    );
}

#[tokio::test]
async fn unrelated_bus_owner_changes_do_not_reload_the_active_menu() {
    let (connection, _) = exporter(false, false).await;
    let mut backend = MenuBackend::connect().await.unwrap();
    let mut events = backend.events().await.unwrap();
    backend.load(&snapshot(&connection)).await.unwrap();
    let unrelated = Connection::session().await.unwrap();
    let owner = unrelated.unique_name().unwrap().to_string();
    unrelated.close().await.unwrap();
    let matching = tokio::time::timeout(std::time::Duration::from_millis(250), async {
        while let Some(event) = events.next().await {
            if event.message.header().member().unwrap().as_str() == "NameOwnerChanged" {
                let (name, _, _): (String, String, String) =
                    event.message.body().deserialize().unwrap();
                if name == owner {
                    return;
                }
            }
        }
    })
    .await;
    assert!(
        matching.is_err(),
        "An unrelated connection must not invalidate a loaded menu"
    );
}
type GtkCalls = Arc<Mutex<Vec<(String, Vec<OwnedValue>)>>>;
struct GtkActions {
    calls: GtkCalls,
}
#[zbus::interface(name = "org.gtk.Actions")]
impl GtkActions {
    fn describe_all(&self) -> HashMap<String, (bool, Signature, Vec<OwnedValue>)> {
        HashMap::from([(
            "mode".into(),
            (true, Signature::try_from("u").unwrap(), vec![42u32.into()]),
        )])
    }
    fn activate(&self, action_name: String, parameters: Vec<OwnedValue>, _platform: Properties) {
        self.calls.lock().unwrap().push((action_name, parameters));
    }
}

#[tokio::test]
async fn gtk_action_keeps_uint_target_and_checked_state() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let connection = Builder::session()
        .unwrap()
        .serve_at("/Menubar", GtkMenus)
        .unwrap()
        .serve_at(
            "/Application",
            GtkActions {
                calls: calls.clone(),
            },
        )
        .unwrap()
        .build()
        .await
        .unwrap();
    let source = WindowSnapshot {
        serial: 1,
        window: Some(WindowInfo::default()),
        dbusmenu: None,
        gtk: Some(GtkAddress {
            bus_name: connection.unique_name().unwrap().to_string(),
            menubar_path: "/Menubar".into(),
            application_path: "/Application".into(),
            ..Default::default()
        }),
    };
    let mut backend = MenuBackend::connect().await.unwrap();
    let tree = backend.load(&source).await.unwrap();
    assert_eq!(tree[0].label, "File");
    assert_eq!(tree[0].children[0].checked, Some(true));
    backend
        .activate(tree[0].children[0].action.as_ref().unwrap())
        .await
        .unwrap();
    let received = calls.lock().unwrap();
    assert_eq!(received[0].0, "mode");
    assert_eq!(u32::try_from(&received[0].1[0]).unwrap(), 42);
}

#[tokio::test]
async fn registrar_keeps_two_xids_and_rejects_other_senders_unregister() {
    // Separate bus: other tests may also own the registrar on the outer test bus.
    let bus = std::process::Command::new("dbus-daemon")
        .args(["--session", "--fork", "--print-address=1", "--print-pid=1"])
        .output()
        .unwrap();
    let output = String::from_utf8(bus.stdout).unwrap();
    let mut lines = output.lines();
    let address = lines.next().unwrap();
    let pid = lines.next().unwrap().to_owned();
    let backend_connection = Builder::address(address).unwrap().build().await.unwrap();
    let mut backend = MenuBackend::with_connection(backend_connection)
        .await
        .unwrap();
    let app = Builder::address(address)
        .unwrap()
        .serve_at(
            "/Menu",
            Exporter {
                calls: Arc::new(Mutex::new(Vec::new())),
                oversized: false,
                slow: false,
            },
        )
        .unwrap()
        .build()
        .await
        .unwrap();
    let other = Builder::address(address).unwrap().build().await.unwrap();
    let registrar = zbus::Proxy::new(
        &app,
        "com.canonical.AppMenu.Registrar",
        "/com/canonical/AppMenu/Registrar",
        "com.canonical.AppMenu.Registrar",
    )
    .await
    .unwrap();
    let path = OwnedObjectPath::try_from("/Menu").unwrap();
    registrar
        .call::<_, _, ()>("RegisterWindow", &(100u32, &path))
        .await
        .unwrap();
    registrar
        .call::<_, _, ()>("RegisterWindow", &(101u32, &path))
        .await
        .unwrap();
    let stranger = zbus::Proxy::new(
        &other,
        "com.canonical.AppMenu.Registrar",
        "/com/canonical/AppMenu/Registrar",
        "com.canonical.AppMenu.Registrar",
    )
    .await
    .unwrap();
    stranger
        .call::<_, _, ()>("UnregisterWindow", &(100u32,))
        .await
        .unwrap();
    let found: (String, OwnedObjectPath) = registrar
        .call("GetMenuForWindow", &(100u32,))
        .await
        .unwrap();
    assert_eq!(found.0, app.unique_name().unwrap().as_str());
    let source = WindowSnapshot {
        window: Some(WindowInfo {
            xid: 101,
            pid: std::process::id(),
            ..Default::default()
        }),
        ..Default::default()
    };
    assert_eq!(backend.load(&source).await.unwrap()[0].label, "File");
    registrar
        .call::<_, _, ()>("UnregisterWindow", &(101u32,))
        .await
        .unwrap();
    assert!(backend.load(&source).await.unwrap().is_empty());
    std::process::Command::new("kill")
        .arg(pid)
        .status()
        .unwrap();
}
