# Verificación — 14 de octubre de 2026

## Resultado y límite principal

El applet compila y genera un ejecutable Linux. El código de `cosmic-comp` con
el parche pasa `cargo check --no-default-features` sobre la revisión fijada.
**Esto no demuestra todavía el funcionamiento dentro del panel COSMIC.**
El equipo disponible está en GNOME/Wayland y no tiene `cosmic-panel` instalado.
No se reemplazó el compositor, no se cambió la sesión y no se instaló el applet.

## Pruebas ejecutadas

Herramienta Rust seleccionada por entorno: 1.98.1. Compilación limitada a uno o
dos trabajos. Archivos de compilación y referencias oficiales en
`/tmp/opencode/`, fuera de la copia GNOME.

| Comprobación | Resultado observado |
| --- | --- |
| Pruebas Rust sin UI en `dbus-run-session` | 44 pruebas aprobadas |
| Pruebas unitarias del applet con UI | 6 aprobadas: identidad del popup, antecesores, errores visibles y cierre GTK; sin renderizar un escritorio |
| D-Bus (`applet/tests/dbus.rs`) | 17: lectura/activación, GTK tipado y vacío, límites, timeout, señales, propietario único conservado al recargar, limpieza, cierre GTK, XID y aislamiento |
| Controlador asíncrono | 4: cancelación, generación antigua, retirada de propietario e invalidación anterior al clic encolado |
| Instantáneas y política de foco | 8: publicación atómica, serial antiguo, retirada, dos ventanas, panel, muerte y bloqueo |
| Estado de UI | 7: sin puente/ventana/exportador, errores, respuestas antiguas, reconexión y clic tardío |
| Protocolo Wayland con socket real | 3: superficies distintas, GTK/capacidad y filtro del puente |
| Registro de destinos | 5: separación, retirada, metadatos vacíos, formato y capacidad |
| Python (parche e instalación) | 12 pruebas aprobadas en directorios temporales, incluidos el contrato desktop del panel y la igualdad de las fuentes incluidas en el parche |
| Instalación/retirada del binario real y validación desktop | Aprobadas, usando un HOME temporal con espacios |
| `cargo check -p cosmic-global-menu --features ui --locked` | Aprobado |
| `cargo build -p cosmic-global-menu --features ui --locked` | Aprobado, perfil de desarrollo |
| Binario `--version` | `cosmic-global-menu 0.1.0 (experimental)` |
| Parche sobre una copia de la revisión real | Comprobación, aplicación y retirada ejecutadas |
| `cargo check --no-default-features` del compositor parcheado | Aprobado |
| `cargo build --no-default-features --locked` del compositor | Intentado; detenido por cuota de disco, sin generar un ejecutable |

Comando de las pruebas del backend/modelo:

```sh
env PATH="$HOME/.cargo/bin:$PATH" RUSTUP_TOOLCHAIN=1.98.1 \
  CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/opencode/cosmic-global-menu-target \
  dbus-run-session -- cargo test --workspace --no-default-features --locked
```

Las bibliotecas de desarrollo que faltaban para comprobar el compositor se
descargaron como paquetes `.deb` y se extrajeron en
`/tmp/opencode/cosmic-dev-sysroot`; no se instalaron con privilegios ni se
alteraron las bibliotecas del sistema. Se usaron `PKG_CONFIG_PATH` y
`LIBRARY_PATH` temporales. La advertencia de compatibilidad futura de
`proc-macro-error2` procede de una dependencia del compositor.

El intento de construir el compositor terminó al crear el archivo de la
dependencia `skrifa`: `Disk quota exceeded (os error 122)`. Se retiró únicamente
la caché incremental de compilación del applet que esta sesión había creado.
No se borraron fuentes ni archivos del usuario y no se repitió el build completo
del compositor. El resultado de `cargo check` del compositor sigue siendo una
comprobación de tipos, no un binario enlazado ni una sesión COSMIC observada.

En el cierre se repitió el check del compositor. Un intento con símbolos de
depuración creó otra variante de dependencias y terminó enlazando
`zerovec-derive` con `Bus error`; una prueba de escritura temporal confirmó
`Disk quota exceeded (os error 122)`. Se retiraron solo los 318,6 MiB de caché
creados por ese intento. Al reutilizar el perfil ligero mediante
`CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_INCREMENTAL=0` y un trabajo,
`cargo check --no-default-features --locked` pasó otra vez. El lockfile de esa
copia de desarrollo incluye la dependencia nueva; no forma parte del parche.

Los fallos iniciales por interfaces ausentes, metadatos excesivos, etiqueta con
`&`, preparación de acción deshabilitada, señales ajenas y acción encolada
antigua se observaron antes de las implementaciones o correcciones respectivas.
Las pruebas usan exportadores controlados, no una aplicación COSMIC real.

## Revisión independiente

Una revisión de solo lectura encontró seis fallos importantes. Se corrigieron
en una única pasada con pruebas de regresión observadas fallar y después pasar:
recarga que cambiaba de propietario, clic previo a una invalidación pendiente,
menús GTK vacíos omitidos por GLib, clave desktop incorrecta, limpieza GTK lenta
y popup que saltaba a otro menú al cambiar el árbol.

Los otros dos hallazgos se elevaron a importantes por su efecto: errores de
activación ocultos y estado de apertura GTK que nunca volvía a false. Ambos
también tienen pruebas de regresión. La suite con UI reúne 50 pruebas Rust;
no sustituye las pruebas manuales del panel. No quedan hallazgos menores de
esa revisión aplazados.

El contrato del lanzador se contrastó con `cosmic-panel` revisión
`3ce6ce1cec97669f91e809962d9446aaefe8a06e`,
`cosmic-panel-bin/src/space/wrapper_space.rs`: la presencia de
`X-HostWaylandDisplay` solicita la conexión al compositor. La prueba Python
comprueba esa solicitud en el desktop instalado, no arranca el panel real.

Una ejecución de la suite también reveló una carrera al consultar el nombre
del registrar mientras salía otra instancia: fallaron
`disappearing_exporter_is_not_replaced_by_new_owner` y
`reloading_same_destination_never_adopts_a_replacement_owner` con
`NameHasNoOwner`. La lectura nativa ya no depende del registrar; solo la ruta
XID lo consulta. Ambos tests y la suite completa pasaron tras la corrección.

La comprobación de empaquetado encontró una diferencia exclusivamente de
formato entre `compositor/integration.rs` y su copia dentro del parche. La
fuente de referencia se sincronizó con el parche ya comprobado, sin cambiar
el parche ni su manifiesto. La prueba
`test_patch_installs_the_bundled_bridge_and_integration_sources` falló antes y
pasó después; además se repitieron aplicación, hashes y retirada en una nueva
copia de la revisión real de `cosmic-comp`.

## Pendiente en COSMIC

Estas comprobaciones **no están aprobadas** por las pruebas anteriores:

- Añadir el applet al panel y comprobar el socket privilegiado proporcionado
  por COSMIC, tamaños, tema, acceso con teclado y posición de popups.
- Cambiar entre dos ventanas de la misma aplicación con menús distintos.
- Abrir un submenú que se construya al recibir `AboutToShow` y ejecutar una
  acción real, incluidas acciones GTK con destino y estado marcado.
- Cerrar o minimizar la ventana seleccionada con el popup abierto; bloquear
  y desbloquear la sesión sin conservar acciones utilizables.
- Desconectar un exportador durante la activación y verificar el error visible.
- Probar una aplicación sin exportador y ventanas Xwayland registradas por XID.
- Probar varios paneles, reinicio del panel y recuperación del puente/bus.
- Construir y ejecutar un compositor de desarrollo junto a `cosmic-panel`;
  la comprobación de tipos del compositor no sustituye su enlazado y ejecución.

## Límites conocidos

GTK por propiedades X11 no está implementado. `gtk_shell1` se anuncia como
versión 1: los hints de startup/presentación son orientativos y no conceden
permisos de activación. La capacidad GTK de menú global se anuncia mientras
exista un consumidor del puente, no como prueba de salud de su backend D-Bus.

Una superficie de capa del shell que no sea el panel también conserva el último
destino mientras siga vivo. La barra muestra hasta siete menús superiores;
los restantes se abren desde «Más». Submenús se navegan en un popup nativo con
«Atrás», no mediante una cascada de ventanas. El perfil release y la
portabilidad del binario a otro equipo no se han verificado.
