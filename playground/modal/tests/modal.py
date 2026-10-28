"""Offline Modal SDK for deploy.py: Volumes are local directories.

spawn runs the deployer's real `run` in a freshly imported module, as the
NAME-deployer container would, with the environment `start` configured."""
import importlib.util
import os
from pathlib import Path
import sys
from types import SimpleNamespace

ROOT = Path(os.environ["FAKE_MODAL_ROOT"])


class _Chain:
    def __getattr__(self, name):
        return lambda *args, **kwargs: self


class Image:
    debian_slim = staticmethod(lambda **kwargs: _Chain())


class Secret:
    from_name = staticmethod(lambda *args, **kwargs: None)


class App:
    def __init__(self, name):
        self.name = name

    def function(self, **kwargs):
        return lambda function: function


class Volume:
    def __init__(self, name):
        self.root = ROOT / name

    @classmethod
    def from_name(cls, name, **kwargs):
        return cls(name)

    def read_file(self, path):
        yield (self.root / path).read_bytes()


class Function:
    def __init__(self, app, name):
        self.app, self.name = app, name

    @classmethod
    def from_name(cls, app, name, **kwargs):
        return cls(app, name)

    def remote(self):
        return {"image_pin": os.environ["FAKE_MODAL_SERVED_PIN"]}

    def spawn(self, request):
        spec = importlib.util.spec_from_file_location("container", sys.modules["__main__"].__file__)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        status = module.run(ROOT / module.VOLUME_NAME, request, lambda: None, lambda: None)
        return SimpleNamespace(get=lambda timeout: status)


class Cls:
    @classmethod
    def from_name(cls, app, name, **kwargs):
        url = os.environ["FAKE_MODAL_WEB_URL"]
        return lambda: SimpleNamespace(web=SimpleNamespace(get_web_url=lambda: url))
