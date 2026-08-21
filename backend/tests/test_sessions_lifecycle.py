"""Session mode contract tests; persistence/auth are covered by their own suites."""

import pytest
from pydantic import ValidationError

from app.sessions import SessionCreate


@pytest.mark.parametrize("mode", ["lecture", "exam", "workshop"])
def test_supported_session_modes(mode: str) -> None:
    assert SessionCreate(class_section="MCA-4B", mode=mode).mode == mode


def test_unknown_session_mode_is_rejected() -> None:
    with pytest.raises(ValidationError):
        SessionCreate(class_section="MCA-4B", mode="attendance-copy")
