"""B7.2: DatasetManifest — every loader's fixed metadata (plan: source + confidence/provenance on
every imported label, applied at the dataset level)."""
import pytest
from pydantic import ValidationError

from app.datasets import DatasetManifest, DatasetPurpose
from app.datasets.loaders import (
    Elliptic2Loader,
    EllipticLoader,
    EllipticPlusPlusLoader,
    KaggleEthFraudLoader,
    TronBootstrapLoader,
)

TRAINING_LOADERS = [KaggleEthFraudLoader, TronBootstrapLoader]
BENCHMARK_LOADERS = [EllipticLoader, Elliptic2Loader, EllipticPlusPlusLoader]


def test_manifest_requires_a_purpose():
    with pytest.raises(ValidationError):
        DatasetManifest(name="x", source="y", version="1")  # type: ignore[call-arg]


def test_manifest_local_path_defaults_to_none_before_loading():
    m = DatasetManifest(name="x", source="y", purpose=DatasetPurpose.TRAINING, version="1")
    assert m.local_path is None


@pytest.mark.parametrize("loader_cls", TRAINING_LOADERS)
def test_training_loaders_declare_training_purpose(loader_cls):
    assert loader_cls.manifest.purpose == DatasetPurpose.TRAINING


@pytest.mark.parametrize("loader_cls", BENCHMARK_LOADERS)
def test_benchmark_loaders_declare_benchmark_purpose(loader_cls):
    assert loader_cls.manifest.purpose == DatasetPurpose.BENCHMARK


@pytest.mark.parametrize("loader_cls", TRAINING_LOADERS + BENCHMARK_LOADERS)
def test_every_loader_manifest_has_a_name_and_source(loader_cls):
    assert loader_cls.manifest.name
    assert loader_cls.manifest.source
    assert loader_cls.manifest.version
