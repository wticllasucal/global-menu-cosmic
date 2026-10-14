// SPDX-License-Identifier: GPL-3.0-only
use cosmic::app::Task;
use cosmic::iced::platform_specific::shell::wayland::commands::popup::{destroy_popup, get_popup};
use cosmic::{
    iced::{self, Length, Limits, Rectangle, Subscription, window},
    prelude::*,
    widget,
};
use cosmic_global_menu::{
    controller::{self, BackendCommand, ControllerEvent, MenuStatus, UiState},
    model::MenuNode,
};
use futures_util::SinkExt;
use tokio::sync::mpsc;

const APP_ID: &str = "local.wticllasuca.GlobalMenu";

fn main() -> cosmic::iced::Result {
    if std::env::args().any(|arg| arg == "--version") {
        println!(
            "cosmic-global-menu {} (experimental)",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }
    cosmic::applet::run::<GlobalMenu>(())
}

#[derive(Default)]
struct GlobalMenu {
    core: cosmic::Core,
    state: UiState,
    commands: Option<mpsc::Sender<BackendCommand>>,
    popup: Option<window::Id>,
    path: Vec<usize>,
}

#[derive(Clone, Debug)]
enum Message {
    Connected(mpsc::Sender<BackendCommand>),
    Backend(ControllerEvent),
    Open(u64, Vec<usize>, Rectangle),
    Navigate(u64, Vec<usize>),
    Choose(u64, Vec<usize>),
    Retry,
    PopupClosed(window::Id),
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl cosmic::Application for GlobalMenu {
    type Executor = cosmic::executor::Default;
    type Flags = ();
    type Message = Message;
    const APP_ID: &'static str = APP_ID;

    fn core(&self) -> &cosmic::Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut cosmic::Core {
        &mut self.core
    }
    fn init(core: cosmic::Core, _: ()) -> (Self, Task<Message>) {
        (
            Self {
                core,
                ..Default::default()
            },
            Task::none(),
        )
    }

    fn subscription(&self) -> Subscription<Message> {
        Subscription::run(|| {
            iced::stream::channel::<Message>(32, async move |mut output| {
                let (commands, receiver) = mpsc::channel(32);
                let (events, mut incoming) = mpsc::channel(32);
                let _actor = AbortOnDrop(tokio::spawn(controller::run(events, receiver)));
                if output.send(Message::Connected(commands)).await.is_err() {
                    return;
                }
                while let Some(event) = incoming.recv().await {
                    if output.send(Message::Backend(event)).await.is_err() {
                        break;
                    }
                }
            })
        })
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Connected(sender) => self.commands = Some(sender),
            Message::Backend(ControllerEvent::Snapshot(snapshot)) => {
                let previous = self
                    .state
                    .snapshot
                    .as_ref()
                    .and_then(|s| s.window.as_ref())
                    .map(|w| w.id);
                let next = snapshot.window.as_ref().map(|w| w.id);
                self.state.select(snapshot);
                if previous != next {
                    return self.close_popup();
                }
            }
            Message::Backend(ControllerEvent::Menus { generation, result }) => {
                self.state.loaded(generation, result)
            }
            Message::Backend(ControllerEvent::Disconnected(error)) => {
                self.state.disconnect(error);
                return self.close_popup();
            }
            Message::Backend(ControllerEvent::ActionResult { generation, error }) => {
                if generation == self.state.generation {
                    self.state.detail = error.unwrap_or_default();
                }
            }
            Message::Open(generation, path, rectangle) => {
                if generation != self.state.generation {
                    return Task::none();
                }
                if let Some(node) = self.node(&path) {
                    if !node.submenu && node.children.is_empty() {
                        return self.update(Message::Choose(generation, path));
                    }
                }
                self.path = path;
                self.prepare_menu();
                let Some(parent) = self.core.main_window_id() else {
                    return Task::none();
                };
                let id = window::Id::unique();
                let old = self.close_popup();
                self.popup = Some(id);
                let mut settings = self
                    .core
                    .applet
                    .get_popup_settings(parent, id, None, None, None);
                settings.positioner.anchor_rect = cosmic::iced::Rectangle {
                    x: rectangle.x.round() as i32,
                    y: rectangle.y.round() as i32,
                    width: rectangle.width.max(1.).round() as i32,
                    height: rectangle.height.max(1.).round() as i32,
                };
                settings.positioner.size_limits = Limits::NONE
                    .min_width(280.)
                    .max_width(360.)
                    .min_height(1.)
                    .max_height(560.);
                return Task::batch([old, get_popup(settings)]);
            }
            Message::Navigate(generation, path) => {
                if generation != self.state.generation {
                    return Task::none();
                }
                self.path = path;
                self.prepare_menu();
            }
            Message::Choose(generation, path) => {
                if let Some(action) = self
                    .state
                    .node_at(generation, &path)
                    .filter(|node| node.visible && node.enabled)
                    .and_then(|node| node.action.clone())
                {
                    self.send(BackendCommand::Activate {
                        generation: self.state.generation,
                        action,
                    });
                    return self.close_popup();
                }
            }
            Message::Retry => self.send(BackendCommand::Retry),
            Message::PopupClosed(id) => {
                if self.popup == Some(id) {
                    self.popup = None;
                }
            }
        }
        Task::none()
    }

    fn on_escape(&mut self) -> Task<Message> {
        self.close_popup()
    }
    fn on_close_requested(&self, id: window::Id) -> Option<Message> {
        Some(Message::PopupClosed(id))
    }

    fn view(&self) -> Element<'_, Message> {
        let generation = self.state.generation;
        let app = self
            .state
            .snapshot
            .as_ref()
            .and_then(|s| s.window.as_ref())
            .map(|w| w.app_id.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("Menú global");
        let name: String = app
            .rsplit('.')
            .next()
            .unwrap_or(app)
            .chars()
            .take(22)
            .collect();
        let app_button = widget::button::custom(widget::text(name))
            .class(cosmic::theme::Button::AppletMenu)
            .padding([4, 8])
            .on_press_with_rectangle(move |_, rect| Message::Open(generation, Vec::new(), rect));
        if !self.core.applet.is_horizontal() {
            return self
                .core
                .applet
                .autosize_window(widget::container(app_button))
                .into();
        }
        let mut row = widget::row([])
            .spacing(0)
            .align_y(iced::Alignment::Center)
            .push(app_button);
        if self.state.status == MenuStatus::Ready {
            for (index, node) in self
                .state
                .nodes
                .iter()
                .enumerate()
                .filter(|(_, n)| n.visible && !n.separator)
                .take(7)
            {
                let title: String = node.label.chars().take(24).collect();
                let mut button = widget::button::custom(widget::text(title))
                    .class(cosmic::theme::Button::AppletMenu)
                    .padding([4, 8]);
                if node.enabled {
                    button = button.on_press_with_rectangle(move |_, rect| {
                        Message::Open(generation, vec![index], rect)
                    });
                }
                row = row.push(button);
            }
            if self
                .state
                .nodes
                .iter()
                .filter(|n| n.visible && !n.separator)
                .count()
                > 7
            {
                row = row.push(
                    widget::button::custom(widget::text("Más"))
                        .class(cosmic::theme::Button::AppletMenu)
                        .padding([4, 8])
                        .on_press_with_rectangle(move |_, rect| {
                            Message::Open(generation, Vec::new(), rect)
                        }),
                );
            }
        } else {
            let status = match self.state.status {
                MenuStatus::MissingBridge => "Falta el puente",
                MenuStatus::Idle => "Sin ventana",
                MenuStatus::Loading => "Cargando…",
                MenuStatus::Unavailable => "Sin menú",
                MenuStatus::Failed => "Menú no disponible",
                MenuStatus::Ready => "",
            };
            row = row.push(
                widget::button::custom(widget::text(status))
                    .class(cosmic::theme::Button::AppletMenu)
                    .padding([4, 8])
                    .on_press_with_rectangle(move |_, rect| {
                        Message::Open(generation, Vec::new(), rect)
                    }),
            );
        }
        self.core.applet.autosize_window(row).into()
    }

    fn view_window(&self, _: window::Id) -> Element<'_, Message> {
        let generation = self.state.generation;
        let mut column = widget::column([]).spacing(2).padding(8);
        if !self.path.is_empty() {
            let mut parent = self.path.clone();
            parent.pop();
            column = column.push(
                widget::button::text("Atrás")
                    .on_press(Message::Navigate(generation, parent))
                    .width(Length::Fill),
            );
            if let Some(node) = self.node(&self.path) {
                column = column.push(widget::text::heading(node.label.clone()));
            }
            column = column.push(widget::divider::horizontal::default());
        }
        if self.state.status == MenuStatus::Ready {
            let nodes = if self.path.is_empty() {
                &self.state.nodes[..]
            } else {
                self.node(&self.path)
                    .map(|n| &n.children[..])
                    .unwrap_or(&[])
            };
            let mut found = false;
            for (index, node) in nodes.iter().enumerate().filter(|(_, n)| n.visible) {
                if node.separator {
                    column = column.push(widget::divider::horizontal::default());
                    continue;
                }
                if node.label.is_empty() {
                    continue;
                }
                found = true;
                let mut path = self.path.clone();
                path.push(index);
                let submenu = node.submenu || !node.children.is_empty();
                let mut content = widget::row([]).spacing(8).align_y(iced::Alignment::Center);
                content = content.push(
                    widget::container(if node.checked == Some(true) {
                        Element::from(widget::icon::from_name("object-select-symbolic").size(16))
                    } else {
                        Element::from(widget::text(""))
                    })
                    .width(20),
                );
                content = content.push(widget::text(node.label.clone()).width(Length::Fill));
                if submenu {
                    content = content.push(widget::icon::from_name("go-next-symbolic").size(16));
                }
                let action = if submenu {
                    Some(Message::Navigate(generation, path))
                } else {
                    node.action
                        .as_ref()
                        .map(|_| Message::Choose(generation, path))
                };
                column = column.push(
                    widget::button::custom(content)
                        .class(cosmic::theme::Button::MenuItem)
                        .padding([6, 8])
                        .width(Length::Fill)
                        .on_press_maybe(if node.enabled { action } else { None }),
                );
            }
            if !found {
                column = column.push(widget::text("No hay acciones en este menú"));
            }
        } else {
            let message = match self.state.status {
                MenuStatus::MissingBridge => {
                    "Este applet necesita el parche de cosmic-comp incluido con el proyecto."
                }
                MenuStatus::Idle => "Selecciona una ventana de aplicación.",
                MenuStatus::Loading => "Leyendo el menú de la aplicación…",
                MenuStatus::Unavailable => {
                    "La aplicación seleccionada no exporta un menú compatible."
                }
                MenuStatus::Failed => "No se pudo leer el menú. Puedes volver a intentarlo.",
                MenuStatus::Ready => "",
            };
            column = column.push(widget::text(message));
        }
        if !self.state.detail.is_empty() {
            column = column.push(widget::text(self.state.detail.clone()));
        }
        if self.state.status == MenuStatus::Failed {
            column = column.push(widget::button::standard("Reintentar").on_press(Message::Retry));
        }
        let scroll = widget::scrollable(column).height(Length::Shrink);
        self.core.applet.popup_container(scroll).into()
    }
}

impl GlobalMenu {
    fn node(&self, path: &[usize]) -> Option<&MenuNode> {
        self.state.node_at(self.state.generation, path)
    }
    fn send(&mut self, command: BackendCommand) {
        match self
            .commands
            .as_ref()
            .map(|sender| sender.try_send(command))
        {
            Some(Ok(())) => {}
            _ => self.state.detail = "El backend está ocupado; vuelve a intentarlo".into(),
        }
    }
    fn prepare_menu(&mut self) {
        if let Some(action) = self.node(&self.path).and_then(|n| n.action.clone()) {
            self.send(BackendCommand::Open {
                generation: self.state.generation,
                action,
            });
        }
    }
    fn close_popup(&mut self) -> Task<Message> {
        self.popup
            .take()
            .map(destroy_popup)
            .unwrap_or_else(Task::none)
    }
}
