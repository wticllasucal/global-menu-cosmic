use cosmic_global_menu::{
    controller::{MenuStatus, UiState},
    model::{MenuNode, WindowInfo, WindowSnapshot},
};

fn snapshot(serial: u32) -> WindowSnapshot {
    WindowSnapshot {
        serial,
        window: Some(WindowInfo {
            id: serial as u64,
            app_id: "test.Editor".into(),
            ..Default::default()
        }),
        ..Default::default()
    }
}

#[test]
fn disconnected_bridge_never_leaves_old_actions() {
    let mut state = UiState::default();
    let generation = state.select(snapshot(1));
    state.loaded(
        generation,
        Ok(vec![MenuNode {
            label: "File".into(),
            ..Default::default()
        }]),
    );
    state.disconnect("falta el parche".into());
    assert_eq!(state.status, MenuStatus::MissingBridge);
    assert!(state.nodes.is_empty());
    assert!(state.snapshot.is_none());
}

#[test]
fn no_window_is_a_neutral_state() {
    let mut state = UiState::default();
    state.select(WindowSnapshot::default());
    assert_eq!(state.status, MenuStatus::Idle);
}

#[test]
fn app_without_exporter_is_not_given_fake_actions() {
    let mut state = UiState::default();
    let generation = state.select(snapshot(1));
    state.loaded(generation, Ok(Vec::new()));
    assert_eq!(state.status, MenuStatus::Unavailable);
    assert!(state.nodes.is_empty());
}

#[test]
fn previous_window_response_is_discarded() {
    let mut state = UiState::default();
    let old = state.select(snapshot(1));
    let new = state.select(snapshot(2));
    state.loaded(
        old,
        Ok(vec![MenuNode {
            label: "wrong".into(),
            ..Default::default()
        }]),
    );
    assert!(state.nodes.is_empty());
    state.loaded(
        new,
        Ok(vec![MenuNode {
            label: "right".into(),
            ..Default::default()
        }]),
    );
    assert_eq!(state.nodes[0].label, "right");
}

#[test]
fn disappeared_service_clears_the_menu() {
    let mut state = UiState::default();
    let generation = state.select(snapshot(1));
    state.loaded(
        generation,
        Ok(vec![MenuNode {
            label: "File".into(),
            ..Default::default()
        }]),
    );
    state.loaded(generation, Err("el servicio desapareció".into()));
    assert_eq!(state.status, MenuStatus::Failed);
    assert!(state.nodes.is_empty());
}

#[test]
fn connection_restart_with_same_serial_does_not_accept_old_response() {
    let mut state = UiState::default();
    let old = state.select(snapshot(1));
    state.disconnect("reinicio".into());
    let new = state.select(snapshot(1));
    assert_ne!(old, new);
    state.loaded(
        old,
        Ok(vec![MenuNode {
            label: "old".into(),
            ..Default::default()
        }]),
    );
    assert!(state.nodes.is_empty());
}

#[test]
fn late_click_never_resolves_to_another_windows_menu_position() {
    let mut state = UiState::default();
    let old = state.select(snapshot(1));
    state.loaded(
        old,
        Ok(vec![MenuNode {
            label: "A".into(),
            visible: true,
            ..Default::default()
        }]),
    );
    let new = state.select(snapshot(2));
    state.loaded(
        new,
        Ok(vec![MenuNode {
            label: "B".into(),
            visible: true,
            ..Default::default()
        }]),
    );
    assert!(state.node_at(old, &[0]).is_none());
    assert_eq!(state.node_at(new, &[0]).unwrap().label, "B");
}
