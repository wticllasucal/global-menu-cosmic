import importlib.util
import configparser
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("install_user", ROOT / "tools/install_user.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "home with spaces"
        self.home.mkdir()
        self.binary = Path(self.temp.name) / "applet"
        self.binary.write_bytes(b"\x7fELFfixture")
        self.binary.chmod(0o755)
        self.template = Path(self.temp.name) / "menu.desktop"
        self.template.write_text("[Desktop Entry]\nType=Application\n@EXEC@\nX-CosmicApplet=true\n")

    def install(self):
        installer.install(self.home, self.binary, self.template)

    def test_installs_only_under_user_home_and_reverts(self):
        self.install()
        target = self.home / ".local/bin/cosmic-global-menu"
        self.assertEqual(target.read_bytes(), self.binary.read_bytes())
        desktop = self.home / ".local/share/applications/local.wticllasuca.GlobalMenu.desktop"
        self.assertIn(f'Exec="{target}"', desktop.read_text())
        installer.uninstall(self.home)
        self.assertFalse(target.exists())
        self.assertFalse(desktop.exists())

    def test_foreign_binary_is_not_overwritten(self):
        target = self.home / ".local/bin/cosmic-global-menu"
        target.parent.mkdir(parents=True)
        target.write_text("user program")
        with self.assertRaises(installer.InstallError):
            self.install()
        self.assertEqual(target.read_text(), "user program")

    def test_panel_launcher_requests_the_host_display_for_the_installed_applet(self):
        installer.install(self.home, self.binary, ROOT / "data/local.wticllasuca.GlobalMenu.desktop")
        desktop = configparser.ConfigParser(interpolation=None)
        desktop.optionxform = str
        desktop.read(self.home / ".local/share/applications/local.wticllasuca.GlobalMenu.desktop")
        entry = desktop["Desktop Entry"]
        # cosmic-panel's wrapper_space launcher tests presence of this key
        # to supply WAYLAND_DISPLAY and X_PRIVILEGED_WAYLAND_SOCKET.
        requests_host = entry.get("X-HostWaylandDisplay") is not None
        self.assertTrue(requests_host, "The official panel launcher would omit the host socket")

    def test_modified_installation_is_not_removed(self):
        self.install()
        target = self.home / ".local/bin/cosmic-global-menu"
        target.write_text("user edits")
        with self.assertRaises(installer.InstallError):
            installer.uninstall(self.home)
        self.assertEqual(target.read_text(), "user edits")

    def test_upgrade_accepts_only_unchanged_owned_files(self):
        self.install()
        self.binary.write_bytes(b"\x7fELFnew-version")
        self.install()
        self.assertEqual((self.home / ".local/bin/cosmic-global-menu").read_bytes(), self.binary.read_bytes())

    def test_symlink_does_not_authorize_overwrite(self):
        folder = self.home / ".local/bin"
        folder.mkdir(parents=True)
        (folder / "cosmic-global-menu").symlink_to(self.binary)
        with self.assertRaises(installer.InstallError):
            self.install()


if __name__ == "__main__":
    unittest.main()
