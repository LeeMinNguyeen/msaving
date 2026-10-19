"""The FastAPI app. Run locally: uvicorn app.api.main:app --reload"""
from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api import errors
from app.api.routes.v1 import accounts, books, budgets, categories, contacts, dashboard, me, reference, transactions
from app.core.settings import settings

app = FastAPI(title="MSaving API")
errors.install(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.app_url, *settings.local_origins],  # the web app (+ localhost on dev only)
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["Content-Disposition"],  # the export's file name
)



# Personal finance data: no cache anywhere (browser, Firebase Hosting's CDN in
# front of the API) may keep a response.
@app.middleware("http")
async def no_store(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


v1 = APIRouter(prefix="/v1")


@v1.get("/health")
def health() -> dict:
    return {"ok": True}


for module in (me, reference, books, accounts, contacts, categories, budgets, transactions, dashboard):
    v1.include_router(module.router)
app.include_router(v1)
