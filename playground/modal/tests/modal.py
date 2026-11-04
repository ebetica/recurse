"""Offline Modal SDK for deploy.py: Volumes are local directories.

spawn runs the deployer's real `run` in a freshly imported module, as the
NAME-deployer container would, with the environment `start` configured."""
import importlib.util
import os
import shutil
from pathlib import Path
import sys
from types import SimpleNamespace

ROOT = Path(os.environ["FAKE_MODAL_ROOT"])


class _Chain:
    def __init__(self):
        self.layers = []

    def __getattr__(self, name):
        def call(*args, **kwargs):
            self.layers.append((name, args))
            return self
        return call


class Image:
    debian_slim = staticmethod(lambda **kwargs: _Chain())


class Secret:
    from_name = staticmethod(lambda *args, **kwargs: None)


class App:
    def __init__(self, name):
        self.name = name

    def function(self, **kwargs):
        return lambda function: function

    cls = function


def concurrent(**kwargs):
    return lambda obj: obj


def web_server(*args, **kwargs):
    return lambda obj: obj


asgi_app = web_server


class _Call:
    """A Dict method callable directly or through `.aio`."""
    def __init__(self, call):
        self.call = call

    def __call__(self, *args):
        return self.call(*args)

    async def aio(self, *args):
        return self.call(*args)


class Dict:
    """An in-memory Dict per name."""
    named = {}

    def __init__(self):
        self.data = {}
        self.put = _Call(self.data.__setitem__)
        self.get = _Call(lambda key, default=None: self.data.get(key, default))

    @classmethod
    def from_name(cls, name, **kwargs):
        return cls.named.setdefault(name, cls())


def exit():
    return lambda obj: obj


def Period(**kwargs):
    return None


class Volume:
    def __init__(self, name):
        self.root = ROOT / name

    @classmethod
    def from_name(cls, name, **kwargs):
        return cls(name)

    def read_file(self, path):
        yield (self.root / path).read_bytes()

    def batch_upload(self, force=False):
        self.force = force
        return self

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def put_file(self, source, path, mode):
        destination = self.root / path
        if destination.exists() and not self.force:
            raise FileExistsError(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        destination.chmod(mode)


class Function:
    def __init__(self, app, name):
        self.app, self.name = app, name

    @classmethod
    def from_name(cls, app, name, **kwargs):
        return cls(app, name)

    def remote(self):
        return {"image_pin": os.environ["FAKE_MODAL_SERVED_PIN"]}

    def get_web_url(self):
        return os.environ["FAKE_MODAL_WEB_URL"]

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
