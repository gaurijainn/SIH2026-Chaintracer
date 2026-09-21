"""Risk + XAI service. B0 ships only the health surface; /score, /typology and
/model-card arrive with B7."""
from fastapi import FastAPI

MODEL_VERSION = "unloaded"  # replaced by tron-xgb-v1 in B7

app = FastAPI(title="PS26183 risk + XAI service")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "ml", "modelVersion": MODEL_VERSION}
