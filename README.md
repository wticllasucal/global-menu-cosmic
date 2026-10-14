# Global Menu para GNOME

Esta rama `gnome` contiene la extensión **Global Menu** y su instalador de
usuario. La versión experimental para COSMIC está en la rama
[`main`](https://github.com/wticllasucal/global-menu-cosmic/tree/main).

La copia original se conserva sin cambios: incluye código, iconos, esquemas,
ayudante nativo y ajustes sin historial del portapapeles.

## Instalar en otro equipo

```sh
git clone --branch gnome https://github.com/wticllasucal/global-menu-cosmic.git
cd global-menu-cosmic
bash instalar.sh
```

Después, cierra la sesión, vuelve a entrar y activa la extensión:

```sh
gnome-extensions enable global-menu@wticllasuca.local
```

El instalador rechaza una copia ya instalada y recompila el ayudante nativo
cuando no coincide con la versión de Mutter del equipo. El binario incluido
corresponde a GNOME 50 en x86_64; no es un binario portable para todas las
versiones. Los requisitos y las instrucciones de aplicaciones están en
[LEEME.txt](LEEME.txt). El historial de esta copia está en
[CAMBIOS.txt](CAMBIOS.txt).

Esta publicación no ejecuta el instalador ni modifica la extensión que está
instalada en el equipo. Las aplicaciones tienen que exportar sus menús para
que se puedan mostrar como menús reales.
