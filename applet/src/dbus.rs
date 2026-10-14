// SPDX-License-Identifier: GPL-3.0-only
use crate::model::{
    ActionKind, DbusAddress, GtkAddress, MenuAction, MenuIdentity, MenuNode, WindowSnapshot,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use futures_util::{Stream, StreamExt};
use std::{
    collections::{HashMap, HashSet},
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use zbus::{
    Connection, MatchRule, Message, MessageStream, Proxy,
    fdo::DBusProxy,
    message::{Header, Type as MessageType},
    object_server::SignalEmitter,
    zvariant::{OwnedObjectPath, OwnedValue, Signature, Structure, Value},
};

const REGISTRAR: &str = "com.canonical.AppMenu.Registrar";
const REGISTRAR_PATH: &str = "/com/canonical/AppMenu/Registrar";
const DBUSMENU: &str = "com.canonical.dbusmenu";
const GTK_MENUS: &str = "org.gtk.Menus";
const GTK_ACTIONS: &str = "org.gtk.Actions";
pub const CALL_TIMEOUT: Duration = Duration::from_secs(3);
const CLEANUP_TIMEOUT: Duration = Duration::from_millis(250);
const MAX_BODY: usize = 4 * 1024 * 1024;
const MAX_DEPTH: usize = 12;
const MAX_NODES: usize = 5000;
const MAX_ITEMS: usize = 400;
type Properties = HashMap<String, OwnedValue>;
type Layout = (i32, Properties, Vec<OwnedValue>);
type GtkMenus = Vec<(u32, u32, Vec<Properties>)>;
type GtkActions = HashMap<String, (bool, Signature, Vec<OwnedValue>)>;
type Watched = Arc<Mutex<HashSet<(String, String)>>>;
type Registrations = Arc<Mutex<HashMap<u32, Registration>>>;

#[derive(Clone)]
struct Registration {
    owner: String,
    path: OwnedObjectPath,
}
struct Registrar {
    registrations: Registrations,
}

#[zbus::interface(name = "com.canonical.AppMenu.Registrar")]
impl Registrar {
    async fn register_window(
        &self,
        window_id: u32,
        menu_object_path: OwnedObjectPath,
        #[zbus(header)] header: Header<'_>,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let sender = header
            .sender()
            .ok_or_else(|| zbus::fdo::Error::AccessDenied("Sin remitente".into()))?
            .to_string();
        if window_id == 0 || !cosmic_global_menu_bridge::valid_path(menu_object_path.as_str()) {
            return Err(zbus::fdo::Error::InvalidArgs(
                "Ventana o ruta no válida".into(),
            ));
        }
        {
            let mut registrations = self.registrations.lock().unwrap();
            if registrations
                .get(&window_id)
                .is_some_and(|r| r.owner != sender)
            {
                return Err(zbus::fdo::Error::AccessDenied(
                    "Ventana registrada por otro cliente".into(),
                ));
            }
            if registrations.len() >= 4096 && !registrations.contains_key(&window_id) {
                return Err(zbus::fdo::Error::LimitsExceeded("Demasiados menús".into()));
            }
            registrations.insert(
                window_id,
                Registration {
                    owner: sender.clone(),
                    path: menu_object_path.clone(),
                },
            );
        }
        Self::window_registered(&emitter, window_id, &sender, &menu_object_path).await?;
        Ok(())
    }

    async fn unregister_window(
        &self,
        window_id: u32,
        #[zbus(header)] header: Header<'_>,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let removed = {
            let mut registrations = self.registrations.lock().unwrap();
            let owned = registrations
                .get(&window_id)
                .is_some_and(|r| header.sender().is_some_and(|s| s.as_str() == r.owner));
            if owned {
                registrations.remove(&window_id);
            }
            owned
        };
        if removed {
            Self::window_unregistered(&emitter, window_id).await?;
        }
        Ok(())
    }

    fn get_menu_for_window(&self, window_id: u32) -> (String, OwnedObjectPath) {
        self.registrations
            .lock()
            .unwrap()
            .get(&window_id)
            .map(|r| (r.owner.clone(), r.path.clone()))
            .unwrap_or_else(|| (String::new(), OwnedObjectPath::try_from("/").unwrap()))
    }

    fn get_menus(&self) -> Vec<(u32, String, OwnedObjectPath)> {
        self.registrations
            .lock()
            .unwrap()
            .iter()
            .map(|(id, r)| (*id, r.owner.clone(), r.path.clone()))
            .collect()
    }

    #[zbus(signal)]
    async fn window_registered(
        emitter: &SignalEmitter<'_>,
        window_id: u32,
        service: &str,
        path: &OwnedObjectPath,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn window_unregistered(emitter: &SignalEmitter<'_>, window_id: u32) -> zbus::Result<()>;
}

#[derive(Debug)]
pub struct BackendEvent {
    pub message: Message,
}
pub type BackendEventStream = Pin<Box<dyn Stream<Item = BackendEvent> + Send>>;

pub struct MenuBackend {
    connection: Connection,
    watched: Watched,
    registrations: Registrations,
    gtk_subscriptions: Vec<(DbusAddress, Vec<u32>)>,
    selected: Option<WindowSnapshot>,
    owners: Mutex<HashMap<String, String>>,
}

impl Drop for MenuBackend {
    fn drop(&mut self) {
        self.release_gtk_subscriptions();
    }
}

impl MenuBackend {
    pub async fn connect() -> Result<Self> {
        Self::with_connection(Connection::session().await?).await
    }

    pub async fn with_connection(connection: Connection) -> Result<Self> {
        let registrations = Arc::new(Mutex::new(HashMap::new()));
        connection
            .object_server()
            .at(
                REGISTRAR_PATH,
                Registrar {
                    registrations: registrations.clone(),
                },
            )
            .await?;
        // Do not steal or queue ownership when another applet/registrar is running.
        match connection
            .request_name_with_flags(REGISTRAR, zbus::fdo::RequestNameFlags::DoNotQueue.into())
            .await
        {
            Ok(_) | Err(zbus::Error::NameTaken) => {}
            Err(error) => return Err(error.into()),
        }
        Ok(Self {
            connection,
            watched: Arc::new(Mutex::new(HashSet::new())),
            registrations,
            gtk_subscriptions: Vec::new(),
            selected: None,
            owners: Mutex::new(HashMap::new()),
        })
    }

    pub async fn events(&self) -> Result<BackendEventStream> {
        let rule = MatchRule::builder().msg_type(MessageType::Signal).build();
        let stream = MessageStream::for_match_rule(rule, &self.connection, Some(64)).await?;
        let watched = self.watched.clone();
        let registrations = self.registrations.clone();
        Ok(Box::pin(stream.filter_map(move |result| {
            let watched = watched.clone();
            let registrations = registrations.clone();
            async move {
                let message = result.ok()?;
                let header = message.header();
                let interface = header.interface()?.as_str();
                let member = header.member()?.as_str();
                if interface == "org.freedesktop.DBus"
                    && member == "NameOwnerChanged"
                    && header
                        .sender()
                        .is_some_and(|s| s.as_str() == "org.freedesktop.DBus")
                {
                    let (name, old, new): (String, String, String) =
                        message.body().deserialize().ok()?;
                    if new.is_empty() {
                        registrations
                            .lock()
                            .unwrap()
                            .retain(|_, r| r.owner != name && r.owner != old);
                    }
                    if watched
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|(owner, _)| owner == &old || owner == &name)
                        || name == REGISTRAR
                    {
                        return Some(BackendEvent { message });
                    }
                    return None;
                }
                if matches!(interface, DBUSMENU | GTK_MENUS | GTK_ACTIONS | REGISTRAR)
                    && watched
                        .lock()
                        .unwrap()
                        .contains(&(header.sender()?.to_string(), header.path()?.to_string()))
                {
                    return Some(BackendEvent { message });
                }
                None
            }
        })))
    }

    pub async fn load(&mut self, snapshot: &WindowSnapshot) -> Result<Vec<MenuNode>> {
        self.release_gtk_subscriptions();
        if self
            .selected
            .as_ref()
            .is_none_or(|old| !old.same_destination(snapshot))
        {
            self.owners.lock().unwrap().clear();
            self.selected = Some(snapshot.clone());
        }
        tokio::time::timeout(CALL_TIMEOUT, self.load_inner(snapshot))
            .await
            .context("Tiempo de espera del exportador agotado")?
    }

    fn release_gtk_subscriptions(&mut self) {
        let subscriptions = std::mem::take(&mut self.gtk_subscriptions);
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        for (address, groups) in subscriptions {
            if groups.is_empty() {
                continue;
            }
            let connection = self.connection.clone();
            // Detached bounded cleanup survives cancellation of the next load.
            // End is only ever sent to the old unique owner.
            runtime.spawn(async move {
                let _ = tokio::time::timeout(
                    CLEANUP_TIMEOUT,
                    connection.call_method(
                        Some(address.bus_name.as_str()),
                        address.path.as_str(),
                        Some(GTK_MENUS),
                        "End",
                        &(groups,),
                    ),
                )
                .await;
            });
        }
    }

    async fn load_inner(&mut self, snapshot: &WindowSnapshot) -> Result<Vec<MenuNode>> {
        self.watched.lock().unwrap().clear();
        let Some(window) = &snapshot.window else {
            return Ok(Vec::new());
        };
        if let Some(address) = &snapshot.dbusmenu {
            return self.load_dbusmenu(address).await;
        }
        if let Some(address) = &snapshot.gtk {
            return self.load_gtk(address).await;
        }
        if window.xid != 0 {
            // Native exports do not depend on a separate registrar's lifetime.
            // XID lookup may claim a now-free name, but never steals or queues it.
            match self
                .connection
                .request_name_with_flags(REGISTRAR, zbus::fdo::RequestNameFlags::DoNotQueue.into())
                .await
            {
                Ok(_) | Err(zbus::Error::NameTaken) => {}
                Err(error) => return Err(error.into()),
            }
            let registrar_owner = DBusProxy::new(&self.connection)
                .await?
                .get_name_owner(zbus::names::BusName::try_from(REGISTRAR)?)
                .await?;
            self.watch(&DbusAddress {
                bus_name: registrar_owner.to_string(),
                path: REGISTRAR_PATH.into(),
            });
            let registrar = Proxy::new(
                &self.connection,
                registrar_owner.as_str(),
                REGISTRAR_PATH,
                REGISTRAR,
            )
            .await?;
            let (service, path): (String, OwnedObjectPath) =
                registrar.call("GetMenuForWindow", &(window.xid,)).await?;
            if !service.is_empty() {
                let pinned = self
                    .pin(&DbusAddress::new(&service, path.as_str()).map_err(|e| anyhow!(e))?)
                    .await?;
                let dbus = DBusProxy::new(&self.connection).await?;
                let pid = dbus
                    .get_connection_unix_process_id(zbus::names::BusName::try_from(
                        pinned.bus_name.as_str(),
                    )?)
                    .await?;
                ensure!(
                    window.pid == 0 || pid == window.pid,
                    "El menú registrado pertenece a otro proceso"
                );
                return self.load_dbusmenu(&pinned).await;
            }
        }
        Ok(Vec::new())
    }

    async fn pin(&self, address: &DbusAddress) -> Result<DbusAddress> {
        DbusAddress::new(&address.bus_name, &address.path).map_err(|e| anyhow!(e))?;
        if let Some(owner) = self.owners.lock().unwrap().get(&address.bus_name) {
            return Ok(DbusAddress {
                bus_name: owner.clone(),
                path: address.path.clone(),
            });
        }
        let bus = DBusProxy::new(&self.connection).await?;
        let owner = bus
            .get_name_owner(zbus::names::BusName::try_from(address.bus_name.as_str())?)
            .await?;
        // Keep the first owner for this destination, even after it vanishes.
        // Signals, retries and title/serial changes are not a new menu export.
        self.owners
            .lock()
            .unwrap()
            .insert(address.bus_name.clone(), owner.to_string());
        Ok(DbusAddress {
            bus_name: owner.to_string(),
            path: address.path.clone(),
        })
    }

    fn watch(&self, address: &DbusAddress) {
        self.watched
            .lock()
            .unwrap()
            .insert((address.bus_name.clone(), address.path.clone()));
    }

    async fn load_dbusmenu(&self, address: &DbusAddress) -> Result<Vec<MenuNode>> {
        let pinned = self.pin(address).await?;
        self.watch(&pinned);
        let proxy = Proxy::new(
            &self.connection,
            pinned.bus_name.as_str(),
            pinned.path.as_str(),
            DBUSMENU,
        )
        .await?;
        let reply = proxy
            .call_method("GetLayout", &(0i32, MAX_DEPTH as i32, Vec::<String>::new()))
            .await?;
        ensure!(
            reply.body().len() <= MAX_BODY,
            "Respuesta supera el límite de tamaño"
        );
        let (_revision, root): (u32, Layout) = reply.body().deserialize()?;
        let mut count = 0;
        let node = parse_layout(root, &pinned, 0, &mut count)?;
        Ok(node.children)
    }

    async fn load_gtk(&mut self, address: &GtkAddress) -> Result<Vec<MenuNode>> {
        address.validate().map_err(|e| anyhow!(e))?;
        let path = if address.menubar_path.is_empty() {
            &address.app_menu_path
        } else {
            &address.menubar_path
        };
        if path.is_empty() {
            return Ok(Vec::new());
        }
        let pinned = self
            .pin(&DbusAddress::new(&address.bus_name, path).map_err(|e| anyhow!(e))?)
            .await?;
        self.watch(&pinned);
        let proxy = Proxy::new(
            &self.connection,
            pinned.bus_name.as_str(),
            pinned.path.as_str(),
            GTK_MENUS,
        )
        .await?;
        let mut menu_data = HashMap::new();
        let mut received_items = 0usize;
        let mut received_bytes = 0usize;
        let mut groups = HashSet::new();
        let mut pending = vec![0];
        let subscription = self.gtk_subscriptions.len();
        self.gtk_subscriptions.push((pinned.clone(), Vec::new()));
        while let Some(group) = pending.pop() {
            if !groups.insert(group) {
                continue;
            }
            ensure!(groups.len() <= MAX_NODES, "Grupos GTK superan el límite");
            self.gtk_subscriptions[subscription].1.push(group);
            let reply = proxy.call_method("Start", &(vec![group],)).await?;
            received_bytes += reply.body().len();
            ensure!(
                received_bytes <= MAX_BODY,
                "Respuesta GTK supera el límite de tamaño"
            );
            let menus: GtkMenus = reply.body().deserialize()?;
            for (g, menu, items) in menus {
                received_items += items.len();
                ensure!(
                    received_items <= MAX_NODES,
                    "Elementos GTK superan el límite total"
                );
                ensure!(
                    g == group && items.len() <= MAX_ITEMS,
                    "Menú GTK supera el límite o grupo no válido"
                );
                for item in &items {
                    for name in [":submenu", ":section"] {
                        if let Some(value) = item.get(name) {
                            let (linked_group, _) = gtk_link(value)?;
                            if !groups.contains(&linked_group) {
                                pending.push(linked_group);
                            }
                        }
                    }
                }
                ensure!(menu_data.len() < MAX_NODES, "Menús GTK superan el límite");
                menu_data.insert((g, menu), items);
            }
        }
        let mut actions = HashMap::new();
        for (prefix, path) in [
            ("app", &address.application_path),
            ("win", &address.window_path),
            ("unity", &pinned.path),
        ] {
            if path.is_empty() {
                continue;
            }
            let action_address = DbusAddress {
                bus_name: pinned.bus_name.clone(),
                path: path.clone(),
            };
            self.watch(&action_address);
            let action_proxy = Proxy::new(
                &self.connection,
                pinned.bus_name.as_str(),
                path.as_str(),
                GTK_ACTIONS,
            )
            .await?;
            match action_proxy.call_method("DescribeAll", &()).await {
                Ok(reply) => {
                    received_bytes += reply.body().len();
                    ensure!(
                        received_bytes <= MAX_BODY,
                        "Acciones GTK superan el límite de tamaño"
                    );
                    let description: GtkActions = reply.body().deserialize()?;
                    ensure!(
                        description.len() <= MAX_NODES,
                        "Acciones GTK superan el límite"
                    );
                    for (name, state) in description {
                        actions.insert(
                            format!("{prefix}.{name}"),
                            (action_address.clone(), name, state),
                        );
                    }
                }
                // Many applications have only app or win actions, not all groups.
                Err(zbus::Error::MethodError(name, _, _))
                    if matches!(
                        name.as_str(),
                        "org.freedesktop.DBus.Error.UnknownInterface"
                            | "org.freedesktop.DBus.Error.UnknownMethod"
                            | "org.freedesktop.DBus.Error.UnknownObject"
                    ) => {}
                Err(error) => return Err(error.into()),
            }
        }
        let mut count = 0;
        parse_gtk(
            (0, 0),
            &menu_data,
            &groups,
            &pinned,
            &actions,
            0,
            &mut count,
            &mut HashSet::new(),
        )
    }

    pub async fn activate(&self, action: &MenuAction) -> Result<()> {
        ensure!(action.enabled, "Acción deshabilitada");
        tokio::time::timeout(CALL_TIMEOUT, async {
            match &action.kind {
                ActionKind::DbusMenu(id) => {
                    let proxy = Proxy::new(
                        &self.connection,
                        action.address.bus_name.as_str(),
                        action.address.path.as_str(),
                        DBUSMENU,
                    )
                    .await?;
                    proxy
                        .call::<_, _, ()>("Event", &(*id, "clicked", Value::from(0i32), 0u32))
                        .await?;
                }
                ActionKind::Gtk {
                    name,
                    target,
                    parameter,
                } => {
                    let mut parameters = Vec::new();
                    if let Some(target) = target {
                        ensure!(
                            target.value_signature() == parameter,
                            "Tipo del destino GTK no válido"
                        );
                        parameters.push(target.try_clone()?);
                    } else {
                        ensure!(
                            parameter.to_string().is_empty(),
                            "Falta el destino de la acción GTK"
                        );
                    }
                    let proxy = Proxy::new(
                        &self.connection,
                        action.address.bus_name.as_str(),
                        action.address.path.as_str(),
                        GTK_ACTIONS,
                    )
                    .await?;
                    proxy
                        .call::<_, _, ()>("Activate", &(name, parameters, Properties::new()))
                        .await?;
                }
                ActionKind::GtkSubmenu(_) => bail!("Un submenú no es una acción activable"),
            }
            Ok(())
        })
        .await
        .context("Tiempo de espera de la acción agotado")?
    }

    pub async fn about_to_show(&self, action: &MenuAction) -> Result<()> {
        ensure!(action.enabled, "Acción deshabilitada");
        tokio::time::timeout(CALL_TIMEOUT, async {
            match &action.kind {
                ActionKind::DbusMenu(id) => {
                    let proxy = Proxy::new(
                        &self.connection,
                        action.address.bus_name.as_str(),
                        action.address.path.as_str(),
                        DBUSMENU,
                    )
                    .await?;
                    let _: bool = proxy.call("AboutToShow", &(*id,)).await?;
                }
                ActionKind::GtkSubmenu(name) => {
                    let proxy = Proxy::new(
                        &self.connection,
                        action.address.bus_name.as_str(),
                        action.address.path.as_str(),
                        GTK_ACTIONS,
                    )
                    .await?;
                    proxy
                        .call::<_, _, ()>("SetState", &(name, Value::from(true), Properties::new()))
                        .await?;
                }
                ActionKind::Gtk { .. } => {}
            }
            Ok(())
        })
        .await
        .context("Tiempo de espera del submenú agotado")?
    }

    pub async fn close_submenu(&self, action: &MenuAction) -> Result<()> {
        let ActionKind::GtkSubmenu(name) = &action.kind else {
            return Ok(());
        };
        ensure!(
            action.address.bus_name.starts_with(':'),
            "El cierre requiere un propietario único"
        );
        tokio::time::timeout(
            CLEANUP_TIMEOUT,
            self.connection.call_method(
                Some(action.address.bus_name.as_str()),
                action.address.path.as_str(),
                Some(GTK_ACTIONS),
                "SetState",
                &(name, Value::from(false), Properties::new()),
            ),
        )
        .await
        .context("Tiempo de espera del cierre agotado")??;
        Ok(())
    }
}

fn label(value: &str) -> String {
    let mut output = String::new();
    let mut chars = value.chars().filter(|c| !c.is_control()).peekable();
    while let Some(c) = chars.next() {
        if c == '_' {
            if chars.peek() == Some(&c) {
                chars.next();
                output.push(c);
            }
        } else {
            output.push(c);
        }
    }
    output.chars().take(200).collect()
}
fn string<'a>(props: &'a Properties, key: &str) -> Option<&'a str> {
    props.get(key).and_then(|v| <&str>::try_from(v).ok())
}
fn boolean(props: &Properties, key: &str, default: bool) -> bool {
    props
        .get(key)
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(default)
}

fn parse_layout(
    layout: Layout,
    address: &DbusAddress,
    depth: usize,
    count: &mut usize,
) -> Result<MenuNode> {
    *count += 1;
    ensure!(
        depth <= MAX_DEPTH && *count <= MAX_NODES && layout.2.len() <= MAX_ITEMS,
        "Árbol supera el límite del menú"
    );
    let (id, props, raw_children) = layout;
    let enabled = boolean(&props, "enabled", true);
    let mut children = Vec::new();
    for raw in raw_children {
        let tuple: Layout = Structure::try_from(raw)?.try_into()?;
        children.push(parse_layout(tuple, address, depth + 1, count)?);
    }
    let checked = string(&props, "toggle-type").map(|_| {
        props
            .get("toggle-state")
            .and_then(|v| i32::try_from(v).ok())
            == Some(1)
    });
    Ok(MenuNode {
        identity: Some(MenuIdentity::DbusMenu(address.clone(), id)),
        label: label(string(&props, "label").unwrap_or_default()),
        enabled,
        visible: boolean(&props, "visible", true),
        separator: string(&props, "type") == Some("separator"),
        submenu: string(&props, "children-display") == Some("submenu") || !children.is_empty(),
        checked,
        action: Some(MenuAction {
            address: address.clone(),
            kind: ActionKind::DbusMenu(id),
            enabled,
        }),
        children,
    })
}

fn gtk_link(value: &OwnedValue) -> Result<(u32, u32)> {
    Ok(<&Structure>::try_from(value)?.try_clone()?.try_into()?)
}
type GtkDescription = HashMap<String, (DbusAddress, String, (bool, Signature, Vec<OwnedValue>))>;

fn parse_gtk(
    key: (u32, u32),
    menus: &HashMap<(u32, u32), Vec<Properties>>,
    groups: &HashSet<u32>,
    address: &DbusAddress,
    actions: &GtkDescription,
    depth: usize,
    count: &mut usize,
    visiting: &mut HashSet<(u32, u32)>,
) -> Result<Vec<MenuNode>> {
    ensure!(
        depth <= MAX_DEPTH && visiting.insert(key),
        "Ciclo o límite de profundidad GTK"
    );
    ensure!(groups.contains(&key.0), "Grupo GTK no consultado");
    // GLib's Start response omits empty menus, including the root.
    let items = menus.get(&key).map(Vec::as_slice).unwrap_or_default();
    let mut output = Vec::new();
    for props in items {
        *count += 1;
        ensure!(*count <= MAX_NODES, "Árbol GTK supera el límite");
        if let Some(section) = props.get(":section") {
            let section_items = parse_gtk(
                gtk_link(section)?,
                menus,
                groups,
                address,
                actions,
                depth + 1,
                count,
                visiting,
            )?;
            if !section_items.is_empty() {
                if !output.is_empty() {
                    output.push(MenuNode {
                        separator: true,
                        visible: true,
                        ..Default::default()
                    });
                }
                output.extend(section_items);
            }
            continue;
        }
        let submenu = props.get(":submenu").map(gtk_link).transpose()?;
        let children = if let Some(submenu) = submenu {
            parse_gtk(
                submenu,
                menus,
                groups,
                address,
                actions,
                depth + 1,
                count,
                visiting,
            )?
        } else {
            Vec::new()
        };
        let full_name = string(props, "action").or_else(|| string(props, "submenu-action"));
        let description = full_name.and_then(|name| actions.get(name));
        let missing = full_name.is_some() && description.is_none();
        let enabled = !missing && description.is_none_or(|(_, _, (enabled, _, _))| *enabled);
        let target = props
            .get("target")
            .map(|v| v.try_clone())
            .transpose()?
            .map(Arc::new);
        let checked = description
            .and_then(|(_, _, (_, _, states))| states.first())
            .and_then(|state| {
                if let Some(target) = &target {
                    Some(state == target.as_ref())
                } else {
                    bool::try_from(state).ok()
                }
            });
        let action = description.map(|(address, name, (_, parameter, _))| MenuAction {
            address: address.clone(),
            enabled,
            kind: if props.contains_key("submenu-action") {
                ActionKind::GtkSubmenu(name.clone())
            } else {
                ActionKind::Gtk {
                    name: name.clone(),
                    target,
                    parameter: parameter.clone(),
                }
            },
        });
        let visible = match string(props, "hidden-when") {
            Some("action-missing") => !missing,
            Some("action-disabled") => enabled,
            _ => true,
        };
        output.push(MenuNode {
            identity: submenu
                .map(|(group, menu)| MenuIdentity::GtkMenu(address.clone(), group, menu)),
            label: label(string(props, "label").unwrap_or_default()),
            enabled,
            visible,
            separator: false,
            submenu: props.contains_key(":submenu"),
            checked,
            action,
            children,
        });
    }
    visiting.remove(&key);
    Ok(output)
}
