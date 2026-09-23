"""Risk + XAI service. B0 shipped only the health surface; B7.1 adds the ML foundation (deps,
module layout, the canonical Appendix-B feature schema) with no scoring behavior yet. /score,
/typology and /model-card arrive with B7.2+."""
from fastapi import FastAPI

from app.models.metadata import UNTRAINED_MODEL_VERSION

app = FastAPI(title="PS26183 risk + XAI service")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "ml", "modelVersion": UNTRAINED_MODEL_VERSION}
