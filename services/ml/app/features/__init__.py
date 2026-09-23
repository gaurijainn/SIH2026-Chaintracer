"""B7 canonical feature schema (plan Appendix B). See schema.py for the FeatureVector type and the
FEATURE_NAMES ordering that training (B7.2+) and inference (B7.2+) both must use so a training row
and a live scoring request always line up feature-for-feature.
"""
from .schema import FEATURE_NAMES, FeatureVector, feature_dict, feature_row

__all__ = ["FEATURE_NAMES", "FeatureVector", "feature_dict", "feature_row"]
