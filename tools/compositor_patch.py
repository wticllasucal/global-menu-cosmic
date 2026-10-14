#!/usr/bin/env python3
"""Apply or remove only this project's patch, never reset a user's checkout."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


class PatchError(RuntimeError):
    pass


def git(source, *args):
    result = subprocess.run(["git", "-C", str(source), *args], capture_output=True, text=True)
    if result.returncode:
        raise PatchError(result.stderr.strip() or result.stdout.strip())
    return result.stdout


def file_hash(source, relative):
    target = source / relative
    if Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise PatchError("Ruta no segura en el manifiesto")
    if target.is_symlink() or any(p.is_symlink() for p in target.parents if p != source):
        raise PatchError(f"No se seguirán enlaces simbólicos: {relative}")
    if not target.exists():
        return None
    if not target.is_file():
        raise PatchError(f"No es un archivo normal: {relative}")
    return hashlib.sha256(target.read_bytes()).hexdigest()


def run(action, source, base, patch, manifest):
    source = Path(source).absolute()
    if action not in ("check", "apply", "revert"):
        raise PatchError("Operación no válida")
    if git(source, "rev-parse", "HEAD").strip() != base:
        raise PatchError(f"Revisión incompatible; se requiere {base}")
    if Path(git(source, "rev-parse", "--show-toplevel").strip()).resolve() != source.resolve():
        raise PatchError("Indica la raíz del repositorio cosmic-comp")
    if action != "revert" and git(source, "status", "--porcelain", "--untracked-files=all").strip():
        raise PatchError("El árbol tiene cambios o archivos sin seguimiento; no se tocarán")
    expected = "after" if action == "revert" else "before"
    for relative, hashes in manifest.items():
        if file_hash(source, relative) != hashes[expected]:
            raise PatchError(f"El archivo no coincide con el estado esperado: {relative}")
    args = ["apply"]
    if action == "revert":
        args.append("--reverse")
    git(source, *args, "--check", str(Path(patch).resolve()))
    if action != "check":
        git(source, *args, str(Path(patch).resolve()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["check", "apply", "revert"])
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    try:
        run(args.action, args.source, (ROOT / "compositor/BASE_COMMIT").read_text().strip(), ROOT / "compositor/global-menu.patch", json.loads((ROOT / "compositor/manifest.json").read_text()))
    except (PatchError, OSError, ValueError) as error:
        print(f"No se modificó el compositor: {error}", file=sys.stderr)
        return 1
    print(f"{args.action}: correcto. No se ha instalado ni iniciado ningún compositor.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
