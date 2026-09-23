"""B7.2: validate_dataframe — required columns, valid labels, timestamp parsing, duplicate
detection, missing-value reporting, row-count/statistics reporting."""
import pandas as pd

from app.datasets import validate_dataframe


def test_reports_row_count_and_label_counts():
    df = pd.DataFrame({"id": ["a", "b", "c"], "label": ["x", "y", "x"]})
    report = validate_dataframe(df, required_columns=["id", "label"], id_column="id", label_column="label", valid_labels={"x", "y"})
    assert report.row_count == 3
    assert report.label_counts == {"x": 2, "y": 1}
    assert report.is_valid


def test_missing_required_column_is_an_error():
    df = pd.DataFrame({"id": ["a"]})
    report = validate_dataframe(df, required_columns=["id", "label"], id_column="id")
    assert not report.is_valid
    assert any("label" in e for e in report.errors)


def test_invalid_label_value_is_an_error():
    df = pd.DataFrame({"id": ["a", "b"], "label": ["x", "not-a-real-label"]})
    report = validate_dataframe(df, required_columns=["id", "label"], id_column="id", label_column="label", valid_labels={"x", "y"})
    assert not report.is_valid
    assert report.invalid_labels == ["not-a-real-label"]


def test_duplicate_ids_are_counted_as_a_warning_not_an_error():
    df = pd.DataFrame({"id": ["a", "a", "b"], "label": ["x", "x", "y"]})
    report = validate_dataframe(df, required_columns=["id"], id_column="id")
    assert report.duplicate_count == 1
    assert report.is_valid  # duplicates alone don't block loading
    assert any("duplicate" in w for w in report.warnings)


def test_missing_values_are_reported_per_column():
    df = pd.DataFrame({"id": ["a", None, "c"], "label": ["x", "y", None]})
    report = validate_dataframe(df, required_columns=["id", "label"], id_column="id")
    assert report.missing_by_column == {"id": 1, "label": 1}


def test_timestamp_parse_failures_are_counted():
    df = pd.DataFrame({"id": ["a", "b", "c"], "ts": ["2026-01-01T00:00:00Z", "not-a-date", None]})
    report = validate_dataframe(df, required_columns=["id"], id_column="id", timestamp_column="ts")
    # "not-a-date" fails to parse; the None value is a missing value, not a parse failure
    assert report.timestamp_parse_failures == 1


def test_valid_timestamps_produce_no_parse_failures():
    df = pd.DataFrame({"id": ["a", "b"], "ts": ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"]})
    report = validate_dataframe(df, required_columns=["id"], id_column="id", timestamp_column="ts")
    assert report.timestamp_parse_failures == 0


def test_label_column_missing_entirely_is_an_error():
    df = pd.DataFrame({"id": ["a"]})
    report = validate_dataframe(df, required_columns=["id"], id_column="id", label_column="label", valid_labels={"x"})
    assert not report.is_valid
