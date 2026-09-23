"""B7 inference: the hybrid score (0.6 x calibrated ML probability + 0.4 x rule score, with hard
overrides for sanctioned/stablecoin-blacklisted addresses) served from POST /score. Arrives once a
model has been trained (B7.2+) — this package is a placeholder; no scoring logic exists yet.
"""
