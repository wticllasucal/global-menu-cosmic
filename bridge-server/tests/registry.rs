use cosmic_global_menu_bridge::{DbusAddress, MenuRegistry};

#[test]
fn two_surfaces_keep_distinct_addresses() {
    let mut registry = MenuRegistry::default();
    registry.set_dbusmenu(1, ":1.20", "/Menu/one").unwrap();
    registry.set_dbusmenu(2, ":1.20", "/Menu/two").unwrap();
    assert_eq!(
        registry.get(1).unwrap().dbusmenu.as_ref().unwrap().path,
        "/Menu/one"
    );
    assert_eq!(
        registry.get(2).unwrap().dbusmenu.as_ref().unwrap().path,
        "/Menu/two"
    );
}

#[test]
fn destroyed_surface_loses_its_menu() {
    let mut registry = MenuRegistry::default();
    registry.set_dbusmenu(1, ":1.20", "/Menu/one").unwrap();
    registry.remove(1);
    assert!(registry.get(1).is_none());
}

#[test]
fn empty_address_removes_exported_menu() {
    let mut registry = MenuRegistry::default();
    registry.set_dbusmenu(1, ":1.20", "/Menu/one").unwrap();
    registry.set_dbusmenu(1, "", "").unwrap();
    assert!(registry.get(1).is_none_or(|menu| menu.dbusmenu.is_none()));
}

#[test]
fn malformed_address_is_not_accepted() {
    assert!(DbusAddress::new("not a bus name", "/Menu").is_err());
    assert!(DbusAddress::new(":1.20", "/Menu/../bad").is_err());
    assert!(DbusAddress::new(":1.20", &format!("/{}", "a".repeat(1025))).is_err());
}

#[test]
fn registry_is_bounded() {
    let mut registry = MenuRegistry::default();
    for id in 0..4096 {
        registry.set_dbusmenu(id, ":1.20", "/Menu").unwrap();
    }
    assert!(registry.set_dbusmenu(4096, ":1.20", "/Menu").is_err());
    registry.remove(1);
    assert!(registry.set_dbusmenu(4096, ":1.20", "/Menu").is_ok());
}
