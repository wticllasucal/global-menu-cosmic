#!/bin/sh
# Builds libgmappmenu.so and its typelib next to this script.
# Needs: gcc pkg-config libwayland-dev libglib2.0-dev gobject-introspection
#        libgirepository1.0-dev gir1.2-glib-2.0-dev
# Rebuild after a Mutter major upgrade (the library links libmutter-NN).
set -eu
cd "$(dirname "$0")"

# The libmutter the running GNOME Shell uses, wherever the distribution keeps
# it (/usr/lib/<arch>/ on Debian/Ubuntu, /usr/lib64/ on Fedora), and not an
# older one left behind by an upgrade.
MUTTER_LIB=$(ldd "$(command -v gnome-shell)" | sed -n 's|.*libmutter-[0-9]*\.so\.0 => \([^ ]*\).*|\1|p' | head -n1)
if [ -z "$MUTTER_LIB" ]; then
    echo "libmutter not found: is GNOME Shell installed?" >&2
    exit 1
fi
MUTTER_NAME=$(basename "$MUTTER_LIB")
LIBDIR=$(dirname "$MUTTER_LIB")

wayland-scanner server-header appmenu.xml appmenu-server-protocol.h
wayland-scanner private-code appmenu.xml appmenu-protocol.c

gcc -shared -fPIC -O2 -Wall -Wextra -Wno-unused-parameter \
    -o libgmappmenu.so gm-appmenu.c appmenu-protocol.c \
    $(pkg-config --cflags --libs gio-2.0 gobject-2.0 wayland-server) \
    -L"$LIBDIR" -l:"$MUTTER_NAME" -Wl,--no-undefined

g-ir-scanner --quiet --warn-all --namespace=GmAppmenu --nsversion=1.0 \
    --identifier-prefix=Gm --symbol-prefix=gm \
    --include=GObject-2.0 --pkg=gobject-2.0 \
    --library=gmappmenu --library-path=. -L. \
    --output=GmAppmenu-1.0.gir gm-appmenu.c gm-appmenu.h
g-ir-compiler GmAppmenu-1.0.gir -o GmAppmenu-1.0.typelib

rm -f appmenu-protocol.c appmenu-server-protocol.h GmAppmenu-1.0.gir
echo "built: $(pwd)/libgmappmenu.so $(pwd)/GmAppmenu-1.0.typelib"
