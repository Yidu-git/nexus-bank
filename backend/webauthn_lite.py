"""A small WebAuthn (passkey / Touch ID) verifier built on `cryptography`.

It covers what Nexus needs and nothing more:
  * registration with attestation "none" (the browser's own check of the sensor
    is what matters here, we don't need a manufacturer certificate)
  * assertions signed with ES256 (what Touch ID uses) or RS256
  * origin, RP-ID, challenge, user-presence and user-verification (fingerprint) checks
  * signature-counter replay protection

The fingerprint itself never reaches the server. The Mac's secure enclave checks
the finger and then signs a one-time challenge; the server only ever sees that
signature and verifies it against the public key saved at sign-up.
"""
import base64
import hashlib
import json
import secrets
import struct
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

ALG_ES256 = -7
ALG_RS256 = -257

FLAG_UP = 0x01   # user present
FLAG_UV = 0x04   # user verified (fingerprint / PIN on the device)
FLAG_AT = 0x40   # attested credential data included


class WebAuthnError(Exception):
    pass


# ----------------------------------------------------------------- base64url
def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64url_decode(text: str) -> bytes:
    if not isinstance(text, str):
        raise WebAuthnError("Malformed credential.")
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except Exception:
        raise WebAuthnError("Malformed credential.")


# ---------------------------------------------------------------- tiny CBOR
def _cbor(data: bytes, pos: int = 0, depth: int = 0):
    """Decode one CBOR item. Returns (value, next_position)."""
    if depth > 8:
        raise WebAuthnError("Malformed credential.")
    try:
        head = data[pos]
        major, info = head >> 5, head & 0x1F
        pos += 1
        if info < 24:
            arg = info
        elif info in (24, 25, 26, 27):
            size = {24: 1, 25: 2, 26: 4, 27: 8}[info]
            if pos + size > len(data):
                raise WebAuthnError("Malformed credential.")
            arg = int.from_bytes(data[pos:pos + size], "big")
            pos += size
        else:
            raise WebAuthnError("Unsupported credential encoding.")  # indefinite length etc.

        if major == 0:
            return arg, pos
        if major == 1:
            return -1 - arg, pos
        if major in (2, 3):
            if pos + arg > len(data):
                raise WebAuthnError("Malformed credential.")
            chunk = data[pos:pos + arg]
            return (chunk if major == 2 else chunk.decode()), pos + arg
        if major == 4:
            if arg > 256:
                raise WebAuthnError("Malformed credential.")
            items = []
            for _ in range(arg):
                item, pos = _cbor(data, pos, depth + 1)
                items.append(item)
            return items, pos
        if major == 5:
            if arg > 256:
                raise WebAuthnError("Malformed credential.")
            out = {}
            for _ in range(arg):
                key, pos = _cbor(data, pos, depth + 1)
                val, pos = _cbor(data, pos, depth + 1)
                out[key] = val
            return out, pos
        if major == 6:  # tag: ignore the tag, keep the value
            return _cbor(data, pos, depth + 1)
        if major == 7:
            if info == 20:
                return False, pos
            if info == 21:
                return True, pos
            if info == 22:
                return None, pos
        raise WebAuthnError("Unsupported credential encoding.")
    except (IndexError, UnicodeDecodeError, TypeError):
        raise WebAuthnError("Malformed credential.")


# ------------------------------------------------------------------- helpers
def _client_data(raw: bytes, expected_type: str, expected_challenge: str, origins):
    try:
        cd = json.loads(raw.decode())
    except Exception:
        raise WebAuthnError("Malformed credential.")
    if cd.get("type") != expected_type:
        raise WebAuthnError("Wrong credential type.")
    if cd.get("challenge") != expected_challenge:
        raise WebAuthnError("This fingerprint request expired. Try again.")
    if cd.get("origin") not in origins:
        raise WebAuthnError("Fingerprint request came from an unexpected website address.")
    return cd


def challenge_from_client_data(raw_b64: str) -> str:
    """Pull the challenge out of clientDataJSON so the caller can look it up."""
    try:
        return json.loads(b64url_decode(raw_b64).decode()).get("challenge", "")
    except Exception:
        raise WebAuthnError("Malformed credential.")


def new_challenge() -> str:
    return b64url(secrets.token_bytes(32))


def _auth_data(raw: bytes, rp_id: str):
    if len(raw) < 37:
        raise WebAuthnError("Malformed credential.")
    if raw[:32] != hashlib.sha256(rp_id.encode()).digest():
        raise WebAuthnError("Fingerprint was registered for a different site.")
    flags = raw[32]
    sign_count = struct.unpack(">I", raw[33:37])[0]
    if not flags & FLAG_UP:
        raise WebAuthnError("No touch detected.")
    if not flags & FLAG_UV:
        raise WebAuthnError("Fingerprint was not verified by the device.")
    return flags, sign_count


def _public_key_from_cose(cose: dict) -> bytes:
    """COSE key -> DER SubjectPublicKeyInfo bytes."""
    kty, alg = cose.get(1), cose.get(3)
    if kty == 2 and alg == ALG_ES256 and cose.get(-1) == 1:
        x, y = cose.get(-2), cose.get(-3)
        if not (isinstance(x, bytes) and isinstance(y, bytes) and len(x) == 32 and len(y) == 32):
            raise WebAuthnError("Malformed credential.")
        key = ec.EllipticCurvePublicNumbers(
            int.from_bytes(x, "big"), int.from_bytes(y, "big"), ec.SECP256R1()).public_key()
    elif kty == 3 and alg == ALG_RS256:
        n, e = cose.get(-1), cose.get(-2)
        if not (isinstance(n, bytes) and isinstance(e, bytes)):
            raise WebAuthnError("Malformed credential.")
        key = rsa.RSAPublicNumbers(int.from_bytes(e, "big"), int.from_bytes(n, "big")).public_key()
    else:
        raise WebAuthnError("This device uses an unsupported key type.")
    return key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


# ------------------------------------------------------------- registration
def registration_options(rp_id, rp_name, user_handle, email, display_name, challenge, exclude_ids,
                         attachment="cross-platform"):
    """attachment: "cross-platform" = the customer's own phone (QR / paired phone),
    "platform" = the fingerprint reader of the device they're on (Touch ID, or their phone itself)."""
    return {
        "rp": {"id": rp_id, "name": rp_name},
        "user": {"id": b64url(user_handle), "name": email, "displayName": display_name},
        "challenge": challenge,
        "pubKeyCredParams": [{"type": "public-key", "alg": ALG_ES256},
                             {"type": "public-key", "alg": ALG_RS256}],
        "timeout": 60000,
        "attestation": "none",
        "authenticatorSelection": {
            "authenticatorAttachment": attachment,
            "residentKey": "required",                # discoverable: lets a tap identify the customer
            "requireResidentKey": True,
            "userVerification": "required",           # must be a fingerprint, not just a touch
        },
        "excludeCredentials": [{"type": "public-key", "id": i} for i in exclude_ids],
    }


def verify_registration(credential, expected_challenge, rp_id, origins):
    """Returns {"credential_id", "public_key", "sign_count"} (strings / int)."""
    try:
        resp = credential["response"]
        client_raw = b64url_decode(resp["clientDataJSON"])
        att_raw = b64url_decode(resp["attestationObject"])
        cred_id_claimed = credential["id"]
    except (KeyError, TypeError):
        raise WebAuthnError("Malformed credential.")

    _client_data(client_raw, "webauthn.create", expected_challenge, origins)
    att, _ = _cbor(att_raw)
    if not isinstance(att, dict) or not isinstance(att.get("authData"), bytes):
        raise WebAuthnError("Malformed credential.")
    auth = att["authData"]
    flags, sign_count = _auth_data(auth, rp_id)
    if not flags & FLAG_AT or len(auth) < 55:
        raise WebAuthnError("No fingerprint key was created.")

    cred_len = struct.unpack(">H", auth[53:55])[0]
    cred_id = auth[55:55 + cred_len]
    if len(cred_id) != cred_len or not 16 <= cred_len <= 1023:
        raise WebAuthnError("Malformed credential.")
    if b64url(cred_id) != cred_id_claimed:
        raise WebAuthnError("Malformed credential.")
    cose, _ = _cbor(auth, 55 + cred_len)
    if not isinstance(cose, dict):
        raise WebAuthnError("Malformed credential.")
    return {
        "credential_id": b64url(cred_id),
        "public_key": b64url(_public_key_from_cose(cose)),
        "sign_count": sign_count,
    }


# ----------------------------------------------------------------- assertion
def authentication_options(rp_id, challenge, allow=()):
    """allow = [{"id", "transports"}] of the fingerprint keys known to Nexus. Naming them lets the
    browser skip its "pick a passkey" list and go to the right device (a paired phone, or the
    local sensor). The key that answers still identifies the customer."""
    return {
        "challenge": challenge,
        "rpId": rp_id,
        "timeout": 60000,
        "userVerification": "required",
        "allowCredentials": [{"type": "public-key", "id": a["id"], "transports": a["transports"]}
                             for a in allow],
    }


def parse_assertion(credential):
    """Returns (credential_id, user_handle_bytes_or_None, parts) without verifying anything yet."""
    try:
        resp = credential["response"]
        parts = {
            "client": b64url_decode(resp["clientDataJSON"]),
            "auth": b64url_decode(resp["authenticatorData"]),
            "sig": b64url_decode(resp["signature"]),
        }
        handle = b64url_decode(resp["userHandle"]) if resp.get("userHandle") else None
        cred_id = credential["id"]
    except (KeyError, TypeError, AttributeError):
        raise WebAuthnError("Malformed credential.")
    if not isinstance(cred_id, str):
        raise WebAuthnError("Malformed credential.")
    return cred_id, handle, parts


def verify_assertion(parts, public_key_b64, stored_sign_count, expected_challenge, rp_id, origins):
    """Raises WebAuthnError unless the signature is valid. Returns the new sign count."""
    _client_data(parts["client"], "webauthn.get", expected_challenge, origins)
    _, sign_count = _auth_data(parts["auth"], rp_id)

    key = serialization.load_der_public_key(b64url_decode(public_key_b64))
    signed = parts["auth"] + hashlib.sha256(parts["client"]).digest()
    try:
        if isinstance(key, ec.EllipticCurvePublicKey):
            key.verify(parts["sig"], signed, ec.ECDSA(hashes.SHA256()))
        else:
            key.verify(parts["sig"], signed, padding.PKCS1v15(), hashes.SHA256())
    except InvalidSignature:
        raise WebAuthnError("Fingerprint could not be verified.")

    # A counter that goes backwards means the key was cloned. (Touch ID keeps it at 0.)
    if (sign_count or stored_sign_count) and sign_count <= stored_sign_count:
        raise WebAuthnError("This fingerprint key looks cloned and was blocked.")
    return sign_count


class ChallengeBox:
    """Short-lived, single-use challenges kept in memory (single-process server)."""

    def __init__(self, ttl=120):
        self.ttl = ttl
        self._items = {}

    def put(self, challenge, **info):
        now = time.time()
        self._items = {k: v for k, v in self._items.items() if v["exp"] > now}
        self._items[challenge] = {"exp": now + self.ttl, **info}

    def pop(self, challenge):
        item = self._items.pop(challenge, None)
        if not item or item["exp"] <= time.time():
            return None
        return item
