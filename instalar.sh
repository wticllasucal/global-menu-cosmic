#!/bin/bash
# Instala Global Menu (real app menus) en este equipo, solo para el usuario actual.
# Uso: bash instalar.sh
set -eu
cd "$(dirname "$0")"

UUID=global-menu@wticllasuca.local
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

if [ -e "$DEST" ]; then
    echo "Ya hay una copia instalada en $DEST; bórrala o muévela antes de instalar."
    exit 1
fi

mkdir -p "$(dirname "$DEST")"
cp -r "$UUID" "$DEST"
glib-compile-schemas "$DEST/schemas"

# El ayudante nativo (menús de Chromium, Firefox y Qt 6 en Wayland) va enlazado a
# una versión concreta de Mutter: el incluido es para GNOME 50 (libmutter-18) en
# x86_64. GNOME 51 usa libmutter-51, así que allí se recompila.
lib_name() { ldd "$1" 2>/dev/null | grep -o 'libmutter-[0-9]*\.so\.0 => /' | head -n1; }
WANTED=$(lib_name "$(command -v gnome-shell)")
if [ -z "$WANTED" ] || [ "$(lib_name "$DEST/native/libgmappmenu.so")" != "$WANTED" ]; then
    echo "El ayudante nativo es de otra versión de GNOME; recompilándolo para esta..."
    if ! (cd "$DEST/native" && sh build.sh); then
        rm -f "$DEST/native/libgmappmenu.so" "$DEST/native/GmAppmenu-1.0.typelib"
        echo
        echo "No se pudo compilar. La extensión funciona igual, pero sin los menús reales de"
        echo "Chromium, Firefox y Qt 6 en Wayland nativo. Para tenerlos, instala:"
        echo "  Ubuntu/Debian: sudo apt install gcc pkg-config libwayland-dev libglib2.0-dev \\"
        echo "                     gobject-introspection libgirepository1.0-dev"
        echo "  Fedora:        sudo dnf install gcc pkgconf-pkg-config wayland-devel glib2-devel \\"
        echo "                     gobject-introspection-devel"
        echo "y luego: cd $DEST/native && sh build.sh   (y cierra sesión otra vez)"
    fi
fi

dconf load /org/gnome/shell/extensions/globalmenu/ < ajustes.dconf

echo
echo "Instalada. Ahora cierra la sesión y vuelve a entrar, y después ejecuta:"
echo "  gnome-extensions enable $UUID"
