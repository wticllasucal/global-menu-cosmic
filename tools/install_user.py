#!/usr/bin/env python3
"""User-only install with ownership hashes; never replaces cosmic-comp."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FILES = (".local/bin/cosmic-global-menu", ".local/share/applications/local.wticllasuca.GlobalMenu.desktop")
MARKER = ".local/share/cosmic-global-menu/installation.json"


class InstallError(RuntimeError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(home, relative):
    target = home / relative
    for path in (target, *target.parents):
        if path == home:
            break
        if path.is_symlink():
            raise InstallError(f"No se seguirán enlaces simbólicos: {path}")
    return target


def owned_files(home):
    marker = safe_path(home, MARKER)
    if not marker.exists():
        return {}
    try:
        data = json.loads(marker.read_text())
    except (ValueError, OSError) as error:
        raise InstallError(f"Registro de instalación no válido: {error}") from error
    if data.get("project") != "cosmic-global-menu" or set(data.get("files", {})) != set(FILES):
        raise InstallError("El registro no pertenece a esta instalación")
    return data["files"]


def check_files(home, owned):
    for relative in FILES:
        path = safe_path(home, relative)
        if path.exists() and (not path.is_file() or owned.get(relative) != digest(path.read_bytes())):
            raise InstallError(f"Archivo ajeno o modificado; no se tocará: {path}")


def write_atomic(path, content, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".global-menu-", delete=False) as temporary:
        temporary.write(content)
        name = temporary.name
    try:
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def install(home, binary, template):
    home = Path(home).absolute()
    binary = Path(binary)
    if not binary.is_file() or binary.is_symlink() or binary.read_bytes()[:4] != b"\x7fELF":
        raise InstallError("Indica el binario ELF compilado; primero ejecuta cargo build --release --features ui")
    owned = owned_files(home)
    check_files(home, owned)
    destination = safe_path(home, FILES[0])
    escaped = str(destination).replace("\\", "\\\\").replace('"', '\\"').replace("`", "\\`").replace("$", "\\$").replace("%", "%%")
    desktop = Path(template).read_text().replace("@EXEC@", f'Exec="{escaped}"').encode()
    contents = {FILES[0]: binary.read_bytes(), FILES[1]: desktop}
    for relative, data in contents.items():
        write_atomic(safe_path(home, relative), data, 0o755 if relative == FILES[0] else 0o644)
    marker = {"project": "cosmic-global-menu", "files": {relative: digest(data) for relative, data in contents.items()}}
    write_atomic(safe_path(home, MARKER), (json.dumps(marker, indent=2) + "\n").encode(), 0o600)


def uninstall(home):
    home = Path(home).absolute()
    owned = owned_files(home)
    if not owned:
        raise InstallError("No existe un registro de instalación propio; no se borrará nada")
    check_files(home, owned)
    for relative in FILES:
        safe_path(home, relative).unlink(missing_ok=True)
    safe_path(home, MARKER).unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "uninstall"], nargs="?", default="install")
    parser.add_argument("--binary", type=Path, default=ROOT / "target/release/cosmic-global-menu")
    args = parser.parse_args()
    try:
        if args.action == "install":
            install(Path.home(), args.binary, ROOT / "data/local.wticllasuca.GlobalMenu.desktop")
        else:
            uninstall(Path.home())
    except (InstallError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(f"{args.action}: applet del usuario. El compositor y la sesión no fueron modificados.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
