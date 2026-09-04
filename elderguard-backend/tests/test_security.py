"""
Token issuing and verification.

Device tokens are the one part of this service's authentication that was
finished, so these tests pin the behaviour that the user-auth work (plan step
4) has to match rather than replace.
"""

from app.core.security import (
    create_device_token,
    create_token,
    decode_token,
    generate_qr_token,
    hash_value,
)


def test_device_token_round_trips() -> None:
    token = create_device_token("11111111-2222-3333-4444-555555555555")
    assert decode_token(token, "device") == "11111111-2222-3333-4444-555555555555"


def test_a_token_of_one_type_does_not_pass_as_another() -> None:
    """
    The `type` claim is what stops a long-lived device token being replayed as
    a user session. A device token is valid for a year; that is only safe while
    it cannot be spent anywhere else.
    """
    token = create_device_token("11111111-2222-3333-4444-555555555555")
    assert decode_token(token, "user") is None


def test_garbage_is_rejected_rather_than_raising() -> None:
    # Callers treat None as "unauthenticated"; an exception here would surface
    # as a 500 and tell an attacker the difference between malformed and wrong.
    assert decode_token("not-a-jwt", "device") is None
    assert decode_token("", "device") is None


def test_an_expired_token_is_rejected() -> None:
    token = create_token("some-subject", "device", expires_minutes=-1)
    assert decode_token(token, "device") is None


def test_qr_tokens_are_unique_and_hash_stably() -> None:
    tokens = {generate_qr_token() for _ in range(100)}
    assert len(tokens) == 100

    one = tokens.pop()
    assert hash_value(one) == hash_value(one)
    assert hash_value(one) != one, "the raw token must never be what is stored"
