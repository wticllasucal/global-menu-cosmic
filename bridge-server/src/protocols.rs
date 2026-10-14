// SPDX-License-Identifier: GPL-3.0-only
macro_rules! server_protocol {
    ($name:ident, $path:literal) => {
        #[allow(unused_imports)]
        pub mod $name {
            use wayland_server;
            use wayland_server::protocol::*;
            pub mod __interfaces {
                use wayland_server::protocol::__interfaces::*;
                wayland_scanner::generate_interfaces!($path);
            }
            use self::__interfaces::*;
            wayland_scanner::generate_server_code!($path);
        }
    };
}

pub mod server {
    server_protocol!(appmenu, "protocols/appmenu.xml");
    server_protocol!(gtk, "protocols/gtk-shell.xml");
    server_protocol!(bridge, "protocols/global-menu.xml");
}

#[cfg(feature = "client")]
pub mod client {
    macro_rules! client_protocol {
        ($name:ident, $path:literal) => {
            #[allow(unused_imports)]
            pub mod $name {
                use wayland_client;
                use wayland_client::protocol::*;
                pub mod __interfaces {
                    use wayland_client::protocol::__interfaces::*;
                    wayland_scanner::generate_interfaces!($path);
                }
                use self::__interfaces::*;
                wayland_scanner::generate_client_code!($path);
            }
        };
    }
    client_protocol!(appmenu, "protocols/appmenu.xml");
    client_protocol!(gtk, "protocols/gtk-shell.xml");
    client_protocol!(bridge, "protocols/global-menu.xml");
}
