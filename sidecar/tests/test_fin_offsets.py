"""Tests for OpenRocket's design-only fin axial offsets."""

from sidecar.conversion import _apply_java_fin_offsets


def _settings():
    return {
        "trapezoidal_fins": {
            "0": {"name": "Forward fins", "position": 0.8},
            "1": {"name": "Aft fins", "position": 1.2},
        },
        "elliptical_fins": {},
    }


def test_matching_java_offsets_replace_serializer_positions():
    settings = _settings()
    report = {"warnings": [], "approximations": []}
    offsets = [
        {"type": "trapezoidal", "name": "Forward fins", "axial_offset_m": 0.31},
        {"type": "trapezoidal", "name": "Aft fins", "axial_offset_m": 0.62},
    ]

    _apply_java_fin_offsets(settings, offsets, report)

    fins = settings["trapezoidal_fins"]
    assert [fins[key]["position"] for key in ("0", "1")] == [0.31, 0.62]
    assert all(
        fins[key]["position_source"] == "OpenRocket FinSet.getAxialOffset(ABSOLUTE)"
        for key in ("0", "1")
    )
    assert not report["warnings"]
    assert "in metres" in report["approximations"][0]


def test_mismatched_java_offsets_keep_serializer_positions_and_report():
    settings = _settings()
    report = {"warnings": [], "approximations": []}
    offsets = [
        {"type": "trapezoidal", "name": "Renamed fins", "axial_offset_m": 0.31},
        {"type": "trapezoidal", "name": "Aft fins", "axial_offset_m": 0.62},
    ]

    _apply_java_fin_offsets(settings, offsets, report)

    fins = settings["trapezoidal_fins"]
    assert [fins[key]["position"] for key in ("0", "1")] == [0.8, 1.2]
    assert all(fins[key]["position_source"] == "RocketSerializer" for key in fins)
    assert any("did not match" in warning for warning in report["warnings"])


def test_missing_java_offsets_keep_serializer_positions_and_report():
    settings = _settings()
    report = {"warnings": [], "approximations": []}

    _apply_java_fin_offsets(settings, None, report)

    assert settings["trapezoidal_fins"]["0"]["position"] == 0.8
    assert settings["trapezoidal_fins"]["0"]["position_source"] == "RocketSerializer"
    assert any("were not supplied" in warning for warning in report["warnings"])
