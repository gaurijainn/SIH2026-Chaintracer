"""B7 dataset loaders: local-file-only readers, one per dataset, each pinned to return either a
TrainingDataset or a BenchmarkDataset (see ../dataset.py). None of these fetch anything remotely —
see base.py's DatasetLoader docstring.
"""
from .b6_export import B6ExportLoader
from .base import DatasetLoader
from .elliptic import EllipticLoader
from .elliptic2 import Elliptic2Loader
from .elliptic_plus_plus import EllipticPlusPlusLoader
from .kaggle_eth_fraud import KaggleEthFraudLoader
from .tron_bootstrap import TronBootstrapLoader

__all__ = [
    "DatasetLoader",
    "KaggleEthFraudLoader",
    "TronBootstrapLoader",
    "B6ExportLoader",
    "EllipticLoader",
    "Elliptic2Loader",
    "EllipticPlusPlusLoader",
]
