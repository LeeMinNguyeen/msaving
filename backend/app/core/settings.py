"""Settings read from the environment, once, at import. Every one is optional:
docker-compose.yml sets what the server needs, and the defaults suit it.
No URL is written into code.
"""
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    # Where the built web app is (web/dist, copied into the image). Missing =
    # the API alone, as in development, where Vite serves the web app.
    web_dir: Path
    # Development only: a localhost origin allowed to call the API from another
    # port. Unset in the image: the web app is served from the API's own origin.
    dev_origin: str


settings = Settings(
    web_dir=Path(os.environ.get("WEB_DIR", "/srv/web")),
    dev_origin=os.environ.get("DEV_ORIGIN", "").rstrip("/"),
)
