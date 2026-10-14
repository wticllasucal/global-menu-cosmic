use cosmic_global_menu::model::{
    BridgeEvent, FocusInput, FocusPolicy, SnapshotAssembler, WindowInfo,
};

fn window(id: u64) -> WindowInfo {
    WindowInfo {
        id,
        app_id: "test.editor".into(),
        title: "document".into(),
        pid: 20,
        xid: 0,
    }
}

#[test]
fn snapshot_waits_for_done() {
    let mut assembler = SnapshotAssembler::default();
    assert!(assembler.push(BridgeEvent::Active(10, window(1))).is_none());
    assert!(
        assembler
            .push(BridgeEvent::DbusMenu(10, ":1.20".into(), "/Menu".into()))
            .is_none()
    );
    let snapshot = assembler.push(BridgeEvent::Done(10)).unwrap();
    assert_eq!(snapshot.window.unwrap().id, 1);
    assert_eq!(snapshot.dbusmenu.unwrap().path, "/Menu");
}

#[test]
fn stale_serial_is_ignored() {
    let mut assembler = SnapshotAssembler::default();
    assembler.push(BridgeEvent::Active(10, window(1)));
    assembler.push(BridgeEvent::Clear(9));
    assert_eq!(
        assembler
            .push(BridgeEvent::Done(10))
            .unwrap()
            .window
            .unwrap()
            .id,
        1
    );
    assembler.push(BridgeEvent::Active(9, window(2)));
    assert!(assembler.push(BridgeEvent::Done(9)).is_none());
}

#[test]
fn clear_removes_old_destinations() {
    let mut assembler = SnapshotAssembler::default();
    assembler.push(BridgeEvent::Active(10, window(1)));
    assembler.push(BridgeEvent::DbusMenu(10, ":1.20".into(), "/Menu".into()));
    assembler.push(BridgeEvent::Done(10));
    assembler.push(BridgeEvent::Clear(11));
    let snapshot = assembler.push(BridgeEvent::Done(11)).unwrap();
    assert!(snapshot.window.is_none());
    assert!(snapshot.dbusmenu.is_none());
}

#[test]
fn serial_can_wrap() {
    let mut assembler = SnapshotAssembler::default();
    assembler.push(BridgeEvent::Active(u32::MAX, window(1)));
    assembler.push(BridgeEvent::Done(u32::MAX));
    assembler.push(BridgeEvent::Active(0, window(2)));
    assert_eq!(
        assembler
            .push(BridgeEvent::Done(0))
            .unwrap()
            .window
            .unwrap()
            .id,
        2
    );
}

#[test]
fn panel_focus_retains_live_target() {
    let mut focus = FocusPolicy::default();
    focus.observe(FocusInput::Window(window(1)), true);
    assert_eq!(focus.observe(FocusInput::Panel, true).unwrap().id, 1);
}

#[test]
fn second_window_replaces_target() {
    let mut focus = FocusPolicy::default();
    focus.observe(FocusInput::Window(window(1)), true);
    assert_eq!(
        focus
            .observe(FocusInput::Window(window(2)), true)
            .unwrap()
            .id,
        2
    );
}

#[test]
fn lock_clears_target() {
    let mut focus = FocusPolicy::default();
    focus.observe(FocusInput::Window(window(1)), true);
    assert!(focus.observe(FocusInput::Locked, true).is_none());
    assert!(focus.observe(FocusInput::Panel, true).is_none());
}

#[test]
fn closed_window_is_not_retained() {
    let mut focus = FocusPolicy::default();
    focus.observe(FocusInput::Window(window(1)), true);
    assert!(focus.observe(FocusInput::Panel, false).is_none());
}
