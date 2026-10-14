# Menú global para COSMIC — versión experimental

Applet Rust y parche separado de `cosmic-comp`. Lee los menús exportados por la
ventana seleccionada y ejecuta sus acciones reales. La extensión GNOME se
publica por separado en la rama
[`gnome`](https://github.com/wticllasucal/global-menu-cosmic/tree/gnome).
La copia GNOME original no se modifica ni se utiliza para instalar este applet.

**Todavía no está validado para uso habitual:** el applet se ha compilado y el
compositor parcheado pasa `cargo check`, pero falta la prueba dentro de COSMIC.
Consulta [VERIFICACION.md](VERIFICACION.md) para distinguir cada resultado.

## Compatibilidad

- Wayland: KDE AppMenu y metadatos de `gtk_shell1` versión 1.
- Bus de sesión: `com.canonical.dbusmenu`, `org.gtk.Menus` y `org.gtk.Actions`.
- Xwayland: registro de menús por XID en `com.canonical.AppMenu.Registrar`.
- Las acciones GTK conservan los tipos de sus parámetros. No se envían atajos
  de teclado ni se inventan acciones para aplicaciones sin exportador.
- **No implementado:** metadatos GTK mediante propiedades X11, extras de GNOME,
  Flatpak ni menús independientes por asiento. Se sigue el asiento activo.

Un parche de compositor no hace que todas las aplicaciones exporten menús.
Aplicaciones con interfaz propia o que no exportan un menú compatible mostrarán
«Sin menú». No se modifica su configuración ni se instalan módulos GTK/Qt.

El foco del panel y sus popups conserva la última ventana válida. También lo
conservan otras superficies de capa del shell; bloqueo, minimización o cierre
de la ventana lo invalidan. La selección usa la superficie o el XID, no títulos.

## Compilar el applet

Necesitas Git, Cargo/Rust compatible con la edición 2024 y `libcosmic` (Rust
1.93 o posterior), Python 3, D-Bus y las bibliotecas de desarrollo de Wayland y
XKB. En Debian/Ubuntu los paquetes habituales son `build-essential`,
`pkg-config`, `libwayland-dev`, `libxkbcommon-dev`, `libxkbcommon-x11-dev`,
`libx11-xcb-dev` y `libvulkan-dev`. La lista exacta depende de la distribución.
La primera compilación necesita Internet para descargar dependencias.

Desde esta carpeta:

```sh
CARGO_BUILD_JOBS=2 cargo build -p cosmic-global-menu --release --features ui --locked
./target/release/cosmic-global-menu --version
```

Si Rust está en `~/.cargo/bin` pero no en el PATH, selecciónalo solo para estos
comandos. Aquí se ha usado `PATH="$HOME/.cargo/bin:$PATH"` y
`RUSTUP_TOOLCHAIN=1.98.1`; no se cambió la configuración persistente del equipo.
En equipos con poca memoria usa `CARGO_BUILD_JOBS=1`.

`Cargo.lock` fija las dependencias. `libcosmic` está fijado a
`e1f2cd2e52226aa50d59bb2cd6d43ffe290106ed`. Las pruebas sin `--features ui`
no requieren iniciar el escritorio.

El panel solicita la conexión al compositor con `X-HostWaylandDisplay`.
El puente consume `X_PRIVILEGED_WAYLAND_SOCKET` por separado de la conexión
gráfica del applet; su entrega real dentro del panel sigue pendiente de prueba.

## Instalar o retirar solo el applet

```sh
sh tools/install.sh install
# Si usaste CARGO_TARGET_DIR u otro perfil:
sh tools/install.sh install --binary /ruta/al/cosmic-global-menu
```

El instalador copia únicamente:

- `~/.local/bin/cosmic-global-menu`
- `~/.local/share/applications/local.wticllasuca.GlobalMenu.desktop`
- `~/.local/share/cosmic-global-menu/installation.json` (registro de hashes)

No requiere `sudo`, no cambia la configuración del panel y no reemplaza el
compositor. Rechaza archivos ajenos, archivos propios modificados y enlaces
simbólicos. Una actualización solo reemplaza archivos propios sin cambios.

En una sesión COSMIC con el compositor compatible, abre **Configuración →
Escritorio → Panel → Applets**, añade **Menú global** y colócalo en el panel.
Puede ser necesario volver a abrir la configuración para que aparezca la
entrada nueva. La ruta exacta de los controles depende de la versión de COSMIC.

Para retirarlo, quítalo primero del panel y ejecuta:

```sh
sh tools/install.sh uninstall
```

No se eliminan archivos modificados por el usuario. Un proceso de applet ya
abierto seguirá vivo hasta retirarlo del panel o cerrar la sesión.

## Parche del compositor: operación separada

La única base admitida es el repositorio oficial `pop-os/cosmic-comp`, revisión
`4d14528f9108cbc0df5404b3b4b8fa6db75ddb41`. No sirve para cualquier paquete
de COSMIC ni para otra revisión. Trabaja con una copia de desarrollo limpia.

```sh
git clone https://github.com/pop-os/cosmic-comp.git /ruta/de/desarrollo/cosmic-comp
git -C /ruta/de/desarrollo/cosmic-comp switch --detach 4d14528f9108cbc0df5404b3b4b8fa6db75ddb41
python3 tools/compositor_patch.py check /ruta/de/desarrollo/cosmic-comp
python3 tools/compositor_patch.py apply /ruta/de/desarrollo/cosmic-comp
```

`check` no escribe. `apply` exige la revisión exacta, un árbol limpio y los
hashes originales de los archivos. Ejecuta `git apply --check` antes de aplicar.
El parche incluye su biblioteca vendorizada; no depende de esta carpeta para
compilar el compositor.

Compila **desde la copia de cosmic-comp**, según sus instrucciones oficiales:

```sh
CARGO_BUILD_JOBS=1 cargo check --no-default-features
CARGO_BUILD_JOBS=1 cargo build --no-default-features
```

Además de Rust, el compositor necesita headers de libinput, libudev, libseat,
GBM/EGL, DRM, pixman, Vulkan y libdisplay-info. `--no-default-features` es la
comprobación de desarrollo sin integración systemd, no un reemplazo del paquete
normal de tu distribución. Cargo puede actualizar el `Cargo.lock` de esa copia.

**No copies el resultado sobre `/usr/bin/cosmic-comp` ni sustituyas la sesión
activa.** Prueba en una VM, otro usuario de pruebas o un compositor anidado.
Para el modo anidado, desde una sesión gráfica existente, la base utiliza:

```sh
COSMIC_BACKEND=winit ./target/debug/cosmic-comp
```

Se necesita también un `cosmic-panel` de desarrollo conectado a ese compositor
y aplicaciones de prueba con menús exportados. Usa un bus de sesión y
configuración aislados para no interferir con los servicios del escritorio
principal. El procedimiento completo debe validarse en el equipo COSMIC;
este proyecto no lo inicia ni instala automáticamente. En este equipo se
intentó construir el ejecutable del compositor, pero la compilación agotó la
cuota de almacenamiento temporal; véase `VERIFICACION.md`.

Para retirar **solo el parche** de la copia de fuentes:

```sh
python3 tools/compositor_patch.py revert /ruta/de/desarrollo/cosmic-comp
```

La herramienta verifica que todos los archivos afectados siguen idénticos al
resultado del parche y aplica el diff inverso. No hace `reset`, no descarta
trabajo ajeno y no elimina cambios de Cargo ni archivos de compilación externos
al parche. Si cambiaste un archivo afectado, guarda esos cambios aparte antes
de decidir cómo retirar el parche; la herramienta se negará a borrarlos.

## Verificar

```sh
sh tools/verify.sh
```

Ejecuta formato Rust, pruebas con bus D-Bus aislado, pruebas de instalación y
parche, `cargo check` y pruebas unitarias del controlador de UI del applet.
Las pruebas no necesitan aplicaciones
instaladas ni acceden al bus de la sesión del usuario. El comando no inicia
COSMIC ni instala nada. Los resultados de este equipo y la lista de pruebas
manuales pendientes están en [VERIFICACION.md](VERIFICACION.md).

## Estructura y licencia

`bridge-server/` contiene el servidor y los XML; `applet/`, el cliente Wayland,
el backend D-Bus y la UI; `compositor/`, el parche y su manifiesto; `tools/`, las
herramientas explícitas de comprobación e instalación.

Código nuevo: GPL-3.0-only, texto en `COPYING`. Los XML KDE/GTK conservan los
avisos y licencias de sus autores. Referencias oficiales:
[cosmic-comp](https://github.com/pop-os/cosmic-comp),
[libcosmic](https://github.com/pop-os/libcosmic),
[plantilla de applet](https://github.com/pop-os/cosmic-applet-template).
