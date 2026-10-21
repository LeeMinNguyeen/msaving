"""Read from the environment once, at import. Every setting is optional."""
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    # Where the built web app is (web/dist, copied into the image). Missing =
    # the API alone, as in development, where Vite serves the web app.
    web_dir: Path


settings = Settings(
    web_dir=Path(os.environ.get("WEB_DIR", "/srv/web")),
)
