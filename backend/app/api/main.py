"""The server: the API under /v1, and the web app's files for everything else.
Run for development: uvicorn app.api.main:app --reload
"""
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api import errors
from app.api.deps import get_public_db
from app.api.routes.v1 import (accounts, admin, books, budgets, categories, contacts, dashboard, me, members, reference,
                               sign_in, transactions)
from app.core import updates
from app.core.settings import settings

# The API's version. Additive changes only within /v1; a client that needs
# something newer checks `api_version` and tells the user to update the server.
API_VERSION = 1
SERVER_VERSION = updates.current_version()

app = FastAPI(title="MSaving API", docs_url=None, redoc_url=None, openapi_url="/v1/openapi.json")
errors.install(app)

if settings.dev_origin:      # development only: the Vite server on another port
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.dev_origin],
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
        expose_headers=["Content-Disposition"],
    )

# Only this server's own web app may call the API from a browser (docs: Sign-in and accounts,
# Clients). Browsers send Origin; a copy of the web app
# hosted anywhere else, or any other site, is refused before anything runs.
# The mobile app sends no Origin, so any number of phones can connect.
# Behind a reverse proxy the browser's address is in Host (Caddy, Tailscale,
# Cloudflare Tunnel keep it) or X-Forwarded-Host.
def own_origin(origin: str, request: Request) -> bool:
    if settings.dev_origin and origin == settings.dev_origin:
        return True
    host = urlsplit(origin).netloc.lower()
    allowed = {request.headers.get("host", ""), *request.headers.get("x-forwarded-host", "").split(",")}
    return bool(host) and host in {h.strip().lower() for h in allowed if h.strip()}


@app.middleware("http")
async def own_web_app_only(request: Request, call_next):
    origin = request.headers.get("origin")
    if request.url.path.startswith("/v1/") and origin is not None and not own_origin(origin, request):
        return JSONResponse({"detail": "origin_not_allowed"}, status_code=403, headers={"Cache-Control": "no-store"})
    return await call_next(request)


# The web app's Content-Security-Policy: nothing from anywhere else. MUI's
# styling (Emotion) adds <style> tags at runtime; QR codes are data: images.
CSP = "; ".join([
    "default-src 'self'", "connect-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", "font-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
])


@app.middleware("http")
async def headers(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/v1/"):
        # Personal finance data: no cache anywhere may keep a response.
        response.headers["Cache-Control"] = "no-store"
    else:
        response.headers["Content-Security-Policy"] = CSP
        immutable = request.url.path.startswith("/assets/")
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if immutable else "no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"     # reset and invite links carry secrets
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    return response


v1 = APIRouter(prefix="/v1")


@v1.get("/health")
def health() -> dict:
    return {"ok": True}


class Instance(BaseModel):
    name: str
    server_version: str
    api_version: int
    signup: str             # invite | open
    setup_needed: bool      # no admin yet: the setup screen, with the code from the server's log


@v1.get("/instance")
def instance(db: Session = Depends(get_public_db)) -> Instance:
    """What a client checks before signing in: the web app's first screen, and
    the mobile app when the user adds a server."""
    row = db.execute(text("select * from instance_info()")).mappings().one()
    return Instance(server_version=SERVER_VERSION, api_version=API_VERSION, **row)


for module in (sign_in, admin, me, reference, books, members, accounts, contacts, categories, budgets, transactions, dashboard):
    v1.include_router(module.router)
app.include_router(v1)


# ---------------------------------------------------------------- the web app

@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"], include_in_schema=False)
def unknown_api(path: str):
    return JSONResponse({"detail": "not_found"}, status_code=404)


@app.get("/{path:path}", include_in_schema=False)
def web(path: str):
    """A file from the built web app, or index.html for the app's own routes
    (/join, /reset, /books/...)."""
    root = settings.web_dir.resolve()
    if not root.is_dir():
        return JSONResponse({"detail": "not_found"}, status_code=404)
    file = (root / path).resolve()
    if path and file.is_file() and file.is_relative_to(root):
        return FileResponse(file)
    return FileResponse(root / "index.html")
