import pytest

from floodmind_desktop_sidecar.agent import StubAgent
from floodmind_desktop_sidecar.app import create_app


@pytest.fixture
def app():
    return create_app(StubAgent())


@pytest.fixture
def client(app):
    return app.test_client()
