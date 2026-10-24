"""Nexus Bank backend: Flask JSON API with a JSON-file database.

Run with a single process (python app.py). The store keeps data in memory and
writes the whole file atomically after every change, guarded by a lock.
"""
import copy
import hashlib
import json
import os
import re
import secrets
import tempfile
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import Flask, g, jsonify, request, send_from_directory
from werkzeug.security import check_password_hash, generate_password_hash

import webauthn_lite as wa

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.environ.get("NEXUS_DATA", os.path.join(BASE_DIR, "data", "nexus.json"))
DIST_DIR = os.path.join(os.path.dirname(BASE_DIR), "frontend", "dist")
SESSION_HOURS = 8
MAX_AMOUNT_CENTS = 1_000_000_00  # per-transaction cap

# Fingerprint Pay (WebAuthn). The site must be opened as http://localhost:5000 (or an
# https:// address): browsers refuse fingerprint prompts on a bare IP like 127.0.0.1.
RP_ID = os.environ.get("NEXUS_RP_ID", "localhost")
RP_NAME = "Nexus Bank"
class OriginList(list):
    """Allowed browser origins. On localhost any port is fine, so PORT=5001 etc. just works."""
    def __contains__(self, origin):
        if super().__contains__(origin):
            return True
        return RP_ID == "localhost" and bool(re.fullmatch(r"http://localhost(:\d{1,5})?", str(origin)))


ORIGINS = OriginList(o.strip() for o in os.environ.get(
    "NEXUS_ORIGINS", "http://localhost:5000,http://localhost:5173").split(",") if o.strip())
CHARGE_MINUTES = 5                  # how long a charge waits for a fingerprint
DEFAULT_FP_LIMIT_CENTS = 5_000_00   # default per-payment fingerprint limit
challenges = wa.ChallengeBox(ttl=120)

app = Flask(__name__, static_folder=None)


# ---------------------------------------------------------------- JSON store
class Store:
    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path):
            with open(path) as f:
                self.data = json.load(f)
        else:
            self.data = {"users": [], "accounts": [], "transactions": [], "sessions": {}}
        # Fill in anything an older database file doesn't have yet.
        self.data.setdefault("seq", {})
        for name in ("user", "account", "transaction", "charge", "credential"):
            self.data["seq"].setdefault(name, 0)
        for name in ("users", "accounts", "transactions", "charges", "credentials"):
            self.data.setdefault(name, [])
        self.data.setdefault("sessions", {})
        self._write(self.data)

    def _write(self, data):
        directory = os.path.dirname(self.path)
        fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)  # atomic swap: never a half-written file
        except Exception:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise

    @contextmanager
    def tx(self):
        """Work on a copy; it is saved only if the block finishes without error."""
        with self.lock:
            working = copy.deepcopy(self.data)
            yield working
            self._write(working)
            self.data = working


store = Store(DATA_PATH)


def next_id(db, name):
    db["seq"][name] += 1
    return db["seq"][name]


# ------------------------------------------------------------------- helpers
class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message, self.status = message, status


@app.errorhandler(ApiError)
def handle_api_error(e):
    return jsonify(error=e.message), e.status


def now():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_amount(value):
    """Turn a user supplied amount (e.g. '12.50') into integer cents."""
    s = str(value).strip()
    if not re.fullmatch(r"\d{1,9}(\.\d{1,2})?", s):
        raise ApiError("Enter a valid amount, e.g. 25 or 25.50.")
    whole, _, frac = s.partition(".")
    cents = int(whole) * 100 + int((frac + "00")[:2])
    if cents <= 0:
        raise ApiError("Amount must be greater than zero.")
    if cents > MAX_AMOUNT_CENTS:
        raise ApiError("Amount exceeds the per-transaction limit.")
    return cents


def new_account_number(db):
    taken = {a["number"] for a in db["accounts"]}
    while True:
        number = "NX" + "".join(secrets.choice("0123456789") for _ in range(10))
        if number not in taken:
            return number


def make_account(db, user_id, kind):
    acct = {
        "id": next_id(db, "account"),
        "user_id": user_id,
        "type": kind,
        "number": new_account_number(db),
        "balance_cents": 0,
        "created_at": iso(now()),
    }
    db["accounts"].append(acct)
    return acct


def account_json(a):
    return {"id": a["id"], "type": a["type"], "number": a["number"],
            "balance": a["balance_cents"] / 100, "created_at": a["created_at"]}


def tx_json(t):
    return {"id": t["id"], "kind": t["kind"], "amount": t["amount_cents"] / 100,
            "balance_after": t["balance_after_cents"] / 100,
            "counterparty": t["counterparty"], "note": t["note"], "created_at": t["created_at"]}


def hash_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


def body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def auth_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        with store.lock:
            session = store.data["sessions"].get(hash_token(token)) if token else None
            if not session or session["expires_at"] <= iso(now()):
                raise ApiError("Please sign in again.", 401)
            user = next((u for u in store.data["users"] if u["id"] == session["user_id"]), None)
            if not user:
                raise ApiError("Please sign in again.", 401)
            g.user = {"id": user["id"], "name": user["name"], "email": user["email"]}
            g.token_hash = hash_token(token)
            return fn(*args, **kwargs)

    return wrapper


def find_owned(db, account_id):
    for a in db["accounts"]:
        if a["id"] == account_id and a["user_id"] == g.user["id"]:
            return a
    raise ApiError("Account not found.", 404)


# ---------------------------------------------------------------------- auth
@app.post("/api/register")
def register():
    data = body()
    name = str(data.get("name", "")).strip()
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    if not name or len(name) > 80:
        raise ApiError("Please enter your name.")
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise ApiError("Please enter a valid email address.")
    if len(password) < 8:
        raise ApiError("Password must be at least 8 characters.")

    with store.tx() as db:
        if any(u["email"] == email for u in db["users"]):
            raise ApiError("An account with that email already exists.", 409)
        user = {"id": next_id(db, "user"), "name": name, "email": email,
                "password_hash": generate_password_hash(password, method="pbkdf2:sha256"),
                "created_at": iso(now())}
        db["users"].append(user)
        make_account(db, user["id"], "checking")
    return jsonify(ok=True), 201


@app.post("/api/login")
def login():
    data = body()
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    token = secrets.token_urlsafe(32)
    with store.tx() as db:
        user = next((u for u in db["users"] if u["email"] == email), None)
        if not user or not check_password_hash(user["password_hash"], password):
            raise ApiError("Incorrect email or password.", 401)
        cutoff = iso(now())
        db["sessions"] = {k: v for k, v in db["sessions"].items() if v["expires_at"] > cutoff}
        db["sessions"][hash_token(token)] = {
            "user_id": user["id"], "expires_at": iso(now() + timedelta(hours=SESSION_HOURS))}
    return jsonify(token=token, user={"id": user["id"], "name": user["name"], "email": user["email"]})


@app.post("/api/logout")
@auth_required
def logout():
    with store.tx() as db:
        db["sessions"].pop(g.token_hash, None)
    return jsonify(ok=True)


@app.get("/api/me")
@auth_required
def me():
    return jsonify(g.user)


# ------------------------------------------------------------------ accounts
@app.get("/api/accounts")
@auth_required
def list_accounts():
    rows = [a for a in store.data["accounts"] if a["user_id"] == g.user["id"]]
    return jsonify([account_json(a) for a in rows])


@app.post("/api/accounts")
@auth_required
def open_account():
    kind = body().get("type")
    if kind not in ("checking", "savings"):
        raise ApiError("Account type must be checking or savings.")
    with store.tx() as db:
        if sum(1 for a in db["accounts"] if a["user_id"] == g.user["id"]) >= 5:
            raise ApiError("You can have at most 5 accounts.")
        acct = make_account(db, g.user["id"], kind)
        result = account_json(acct)
    return jsonify(result), 201


@app.get("/api/accounts/<int:account_id>/transactions")
@auth_required
def history(account_id):
    find_owned(store.data, account_id)
    limit = min(max(request.args.get("limit", 50, type=int), 1), 200)
    rows = [t for t in store.data["transactions"] if t["account_id"] == account_id]
    rows.sort(key=lambda t: t["id"], reverse=True)
    return jsonify([tx_json(t) for t in rows[:limit]])


# --------------------------------------------------------------- money moves
def apply_change(db, acct, delta_cents, kind, counterparty=None, note=None):
    new_balance = acct["balance_cents"] + delta_cents
    if new_balance < 0:
        raise ApiError("Insufficient funds.")
    acct["balance_cents"] = new_balance
    db["transactions"].append({
        "id": next_id(db, "transaction"), "account_id": acct["id"], "kind": kind,
        "amount_cents": abs(delta_cents), "balance_after_cents": new_balance,
        "counterparty": counterparty, "note": note, "created_at": iso(now()),
    })
    return new_balance


def clean_note(value):
    return (str(value).strip()[:140] or None) if value else None


def account_id_from(data, key):
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ApiError("Account not found.", 404)
    return value


@app.post("/api/deposit")
@auth_required
def deposit():
    data = body()
    cents = parse_amount(data.get("amount"))
    with store.tx() as db:
        acct = find_owned(db, account_id_from(data, "account_id"))
        bal = apply_change(db, acct, cents, "deposit", note=clean_note(data.get("note")))
    return jsonify(balance=bal / 100)


@app.post("/api/withdraw")
@auth_required
def withdraw():
    data = body()
    cents = parse_amount(data.get("amount"))
    with store.tx() as db:
        acct = find_owned(db, account_id_from(data, "account_id"))
        bal = apply_change(db, acct, -cents, "withdrawal", note=clean_note(data.get("note")))
    return jsonify(balance=bal / 100)


def do_transfer(data, note):
    cents = parse_amount(data.get("amount"))
    number = str(data.get("to_account_number", "")).strip().upper()
    with store.tx() as db:
        src = find_owned(db, account_id_from(data, "from_account_id"))
        dest = next((a for a in db["accounts"] if a["number"] == number), None)
        if not dest:
            raise ApiError("Destination account not found.", 404)
        if dest["id"] == src["id"]:
            raise ApiError("Choose a different destination account.")
        bal = apply_change(db, src, -cents, "transfer_out", counterparty=dest["number"], note=note)
        apply_change(db, dest, cents, "transfer_in", counterparty=src["number"], note=note)
    return jsonify(balance=bal / 100)


@app.post("/api/transfer")
@auth_required
def transfer():
    data = body()
    return do_transfer(data, clean_note(data.get("note")))


@app.post("/api/bluetooth-pay")
@auth_required
def bluetooth_pay():
    data = body()
    device = str(data.get("device_name", "")).strip()[:60]
    if not device:
        raise ApiError("Select a Bluetooth device first.")
    data["from_account_id"] = data.get("account_id")
    return do_transfer(data, f"Bluetooth Pay \u00b7 {device}")


# ------------------------------------------------------- Fingerprint Pay
# How it works:
#   * At sign-up the customer's Mac creates a passkey locked behind Touch ID. Only the
#     public half reaches the server; the fingerprint never leaves the Mac's secure chip.
#   * A merchant (the company) picks a price on their phone -> a "charge" is created.
#   * The payment terminal (the Mac with the fingerprint reader, signed in as the merchant)
#     asks for a fingerprint. The signed answer identifies the customer, and the
#     money moves from their account to the merchant's in one all-or-nothing step.
@app.errorhandler(wa.WebAuthnError)
def handle_webauthn_error(e):
    return jsonify(error=str(e)), 400


def etb(cents):
    return f"ETB {cents / 100:,.2f}"


def user_row(db, user_id):
    return next((u for u in db["users"] if u["id"] == user_id), None)


def default_account(db, user):
    """The account fingerprint payments are taken from."""
    mine = [a for a in db["accounts"] if a["user_id"] == user["id"]]
    wanted = user.get("fp_account_id")
    return next((a for a in mine if a["id"] == wanted), None) or next(
        (a for a in mine if a["type"] == "checking"), mine[0] if mine else None)


def credential_json(c):
    return {"id": c["id"], "label": c["label"], "created_at": c["created_at"],
            "last_used_at": c.get("last_used_at")}


def credential_challenge(data):
    try:
        return wa.challenge_from_client_data(data["credential"]["response"]["clientDataJSON"])
    except (KeyError, TypeError):
        raise ApiError("Malformed fingerprint response.")


@app.get("/api/fingerprint")
@auth_required
def fingerprint_status():
    db = store.data
    user = user_row(db, g.user["id"])
    acct = default_account(db, user)
    return jsonify(
        credentials=[credential_json(c) for c in db["credentials"] if c["user_id"] == user["id"]],
        account_id=acct["id"] if acct else None,
        limit=user.get("fp_limit_cents", DEFAULT_FP_LIMIT_CENTS) / 100,
        rp_id=RP_ID)


@app.put("/api/fingerprint/settings")
@auth_required
def fingerprint_settings():
    data = body()
    with store.tx() as db:
        user = user_row(db, g.user["id"])
        if "account_id" in data:
            acct = find_owned(db, account_id_from(data, "account_id"))
            user["fp_account_id"] = acct["id"]
        if "limit" in data:
            user["fp_limit_cents"] = parse_amount(data["limit"])
    return jsonify(ok=True)


@app.post("/api/fingerprint/register/options")
@auth_required
def fingerprint_register_options():
    with store.tx() as db:
        user = user_row(db, g.user["id"])
        mine = [c for c in db["credentials"] if c["user_id"] == user["id"]]
        if len(mine) >= 5:
            raise ApiError("You can register at most 5 fingerprints/devices.")
        if not user.get("fp_handle"):
            user["fp_handle"] = wa.b64url(secrets.token_bytes(32))  # random, not the user id
        handle = wa.b64url_decode(user["fp_handle"])
        exclude = [c["credential_id"] for c in mine]
    challenge = wa.new_challenge()
    challenges.put(challenge, kind="register", user_id=g.user["id"])
    attachment = "platform" if body().get("device") == "this" else "cross-platform"
    return jsonify(wa.registration_options(
        RP_ID, RP_NAME, handle, user["email"], user["name"], challenge, exclude, attachment))


@app.post("/api/fingerprint/register/verify")
@auth_required
def fingerprint_register_verify():
    data = body()
    challenge = credential_challenge(data)
    info = challenges.pop(challenge)
    if not info or info["kind"] != "register" or info["user_id"] != g.user["id"]:
        raise ApiError("That fingerprint request expired. Try again.")
    result = wa.verify_registration(data["credential"], challenge, RP_ID, ORIGINS)
    label = str(data.get("label", "")).strip()[:40] or "This device"
    raw_tr = data["credential"].get("transports") if isinstance(data["credential"], dict) else None
    transports = [t for t in (raw_tr if isinstance(raw_tr, list) else [])
                  if t in ("usb", "nfc", "ble", "hybrid", "internal", "smart-card")][:6]
    with store.tx() as db:
        if any(c["credential_id"] == result["credential_id"] for c in db["credentials"]):
            raise ApiError("That fingerprint is already registered.", 409)
        row = {"id": next_id(db, "credential"), "user_id": g.user["id"], "label": label,
               "credential_id": result["credential_id"], "public_key": result["public_key"],
               "sign_count": result["sign_count"], "transports": transports,
               "created_at": iso(now()), "last_used_at": None}
        db["credentials"].append(row)
    return jsonify(credential_json(row)), 201


@app.delete("/api/fingerprint/credentials/<int:cred_id>")
@auth_required
def fingerprint_delete(cred_id):
    with store.tx() as db:
        before = len(db["credentials"])
        db["credentials"] = [c for c in db["credentials"]
                             if not (c["id"] == cred_id and c["user_id"] == g.user["id"])]
        if len(db["credentials"]) == before:
            raise ApiError("Fingerprint not found.", 404)
    return jsonify(ok=True)


# -------------------------------------------------------------- merchant
def merchant_json(m, user):
    return {"enabled": True, "name": m["name"], "account_id": m["account_id"],
            "items": [{"id": i["id"], "name": i["name"], "price": i["price_cents"] / 100}
                      for i in m["items"]]}


def require_merchant(db):
    user = user_row(db, g.user["id"])
    if not user.get("merchant"):
        raise ApiError("Set up your business first (Business in the menu).", 403)
    return user, user["merchant"]


@app.get("/api/merchant")
@auth_required
def merchant_get():
    user = user_row(store.data, g.user["id"])
    m = user.get("merchant")
    return jsonify(merchant_json(m, user) if m else {"enabled": False, "name": "", "account_id": None, "items": []})


@app.put("/api/merchant")
@auth_required
def merchant_put():
    data = body()
    name = str(data.get("name", "")).strip()
    if not name or len(name) > 60:
        raise ApiError("Enter your business name.")
    raw_items = data.get("items", [])
    if not isinstance(raw_items, list) or len(raw_items) > 50:
        raise ApiError("You can have up to 50 items.")
    with store.tx() as db:
        user = user_row(db, g.user["id"])
        old = user.get("merchant") or {"items": [], "next_item_id": 1}
        acct = find_owned(db, account_id_from(data, "account_id"))
        old_ids = {i["id"] for i in old["items"]}
        next_item = old["next_item_id"]
        items = []
        for raw in raw_items:
            if not isinstance(raw, dict):
                raise ApiError("Invalid item.")
            item_name = str(raw.get("name", "")).strip()
            if not item_name or len(item_name) > 40:
                raise ApiError("Each item needs a name (up to 40 characters).")
            item_id = raw.get("id")
            if isinstance(item_id, bool) or not isinstance(item_id, int) or item_id not in old_ids:
                item_id, next_item = next_item, next_item + 1
            items.append({"id": item_id, "name": item_name, "price_cents": parse_amount(raw.get("price"))})
        user["merchant"] = {"name": name, "account_id": acct["id"], "items": items, "next_item_id": next_item}
        result = merchant_json(user["merchant"], user)
    return jsonify(result)


def charge_status(c):
    if c["status"] == "pending" and c["expires_at"] <= iso(now()):
        return "expired"
    return c["status"]


def charge_json(db, c):
    customer = user_row(db, c["customer_user_id"]) if c.get("customer_user_id") else None
    return {"id": c["id"], "amount": c["amount_cents"] / 100, "label": c["label"],
            "status": charge_status(c), "error": c.get("last_error"),
            "created_at": c["created_at"], "expires_at": c["expires_at"], "paid_at": c.get("paid_at"),
            "customer": customer["name"] if customer else None}


def find_charge(db, charge_id):
    c = next((c for c in db["charges"] if c["id"] == charge_id and c["merchant_user_id"] == g.user["id"]), None)
    if not c:
        raise ApiError("Charge not found.", 404)
    return c


@app.post("/api/merchant/charges")
@auth_required
def charge_create():
    """Phone 'price selector': build a charge from catalogue items and/or a custom amount."""
    data = body()
    with store.tx() as db:
        user, m = require_merchant(db)
        catalogue = {i["id"]: i for i in m["items"]}
        total, parts = 0, []
        for line in data.get("items") or []:
            item = catalogue.get(line.get("id")) if isinstance(line, dict) else None
            qty = line.get("qty") if isinstance(line, dict) else None
            if not item or isinstance(qty, bool) or not isinstance(qty, int) or not 1 <= qty <= 99:
                raise ApiError("That item isn't on your price list any more. Refresh and try again.")
            total += item["price_cents"] * qty
            parts.append(f"{qty}× {item['name']}")
        if str(data.get("custom_amount", "")).strip():
            total += parse_amount(data["custom_amount"])
            parts.append("Custom amount")
        if total <= 0:
            raise ApiError("Pick at least one item or enter an amount.")
        if total > MAX_AMOUNT_CENTS:
            raise ApiError("Amount exceeds the per-transaction limit.")
        for old in db["charges"]:  # one open charge per merchant: the terminal always knows which to take
            if old["merchant_user_id"] == user["id"] and old["status"] == "pending":
                old["status"] = "cancelled"
        charge = {"id": next_id(db, "charge"), "merchant_user_id": user["id"], "account_id": m["account_id"],
                  "amount_cents": total, "label": ", ".join(parts)[:140], "status": "pending",
                  "created_at": iso(now()), "expires_at": iso(now() + timedelta(minutes=CHARGE_MINUTES))}
        db["charges"].append(charge)
        result = charge_json(db, charge)
    return jsonify(result), 201


@app.get("/api/merchant/charges/<int:charge_id>")
@auth_required
def charge_get(charge_id):
    return jsonify(charge_json(store.data, find_charge(store.data, charge_id)))


@app.post("/api/merchant/charges/<int:charge_id>/cancel")
@auth_required
def charge_cancel(charge_id):
    with store.tx() as db:
        c = find_charge(db, charge_id)
        if c["status"] == "pending":
            c["status"] = "cancelled"
        result = charge_json(db, c)
    return jsonify(result)


@app.get("/api/merchant/terminal")
@auth_required
def terminal_current():
    """Payment terminal (the Mac) polls this to see what, if anything, is waiting for a finger."""
    db = store.data
    mine = [c for c in db["charges"] if c["merchant_user_id"] == g.user["id"]]
    latest = max(mine, key=lambda c: c["id"], default=None)
    return jsonify(charge=charge_json(db, latest) if latest else None, server_time=iso(now()))


@app.post("/api/pay/fingerprint/options")
@auth_required
def pay_options():
    data = body()
    charge_id = account_id_from(data, "charge_id")
    with store.lock:
        charge = find_charge(store.data, charge_id)
        if charge_status(charge) != "pending":
            raise ApiError("That charge is no longer waiting for payment.", 409)
        amount = charge["amount_cents"]
    challenge = wa.new_challenge()
    challenges.put(challenge, kind="pay", charge_id=charge_id, merchant_id=g.user["id"], amount_cents=amount)
    known = [{"id": c["credential_id"], "transports": c.get("transports") or ["internal", "hybrid"]}
             for c in store.data["credentials"]][:500]
    return jsonify(wa.authentication_options(RP_ID, challenge, known))


@app.post("/api/pay/fingerprint/verify")
@auth_required
def pay_verify():
    data = body()
    credential = data.get("credential")
    challenge = credential_challenge(data)
    info = challenges.pop(challenge)
    if not info or info["kind"] != "pay" or info["merchant_id"] != g.user["id"]:
        raise ApiError("This fingerprint request expired. Try again.")
    cred_id, handle, parts = wa.parse_assertion(credential)
    charge_id = info["charge_id"]

    try:
        with store.tx() as db:
            charge = find_charge(db, charge_id)
            if charge_status(charge) != "pending":
                raise ApiError("That charge is no longer waiting for payment.", 409)
            if charge["amount_cents"] != info["amount_cents"]:
                raise ApiError("The price changed. Try again.", 409)

            row = next((c for c in db["credentials"] if c["credential_id"] == cred_id), None)
            customer = user_row(db, row["user_id"]) if row else None
            if not customer or handle is None or wa.b64url(handle) != customer.get("fp_handle"):
                raise ApiError("Fingerprint not recognised. Is it registered with a Nexus account?", 403)
            row["sign_count"] = wa.verify_assertion(
                parts, row["public_key"], row["sign_count"], challenge, RP_ID, ORIGINS)
            row["last_used_at"] = iso(now())

            # From here on the customer is proven. Anything that goes wrong is a "decline".
            payer = default_account(db, customer)
            merchant_acct = next(a for a in db["accounts"] if a["id"] == charge["account_id"])
            cents = charge["amount_cents"]
            if not payer or payer["id"] == merchant_acct["id"]:
                raise ApiError("A business can't pay into its own account. Use a different customer account.", 402)
            limit = customer.get("fp_limit_cents", DEFAULT_FP_LIMIT_CENTS)
            if cents > limit:
                raise ApiError(f"Over this fingerprint limit of {etb(limit)}.", 402)
            if payer["balance_cents"] < cents:
                raise ApiError("Insufficient funds.", 402)

            merchant = user_row(db, charge["merchant_user_id"])["merchant"]
            apply_change(db, payer, -cents, "fingerprint_out", counterparty=merchant_acct["number"],
                         note=f"Fingerprint Pay · {merchant['name']}")
            apply_change(db, merchant_acct, cents, "fingerprint_in", counterparty=payer["number"],
                         note=f"Fingerprint sale · {charge['label']}")
            charge.update(status="paid", paid_at=iso(now()), customer_user_id=customer["id"],
                          customer_account_id=payer["id"], last_error=None)
            result = charge_json(db, charge)
    except ApiError as e:
        if e.status == 402:   # remember why, so the phone can show it
            with store.tx() as db:
                c = find_charge(db, charge_id)
                if c["status"] == "pending":
                    c["last_error"] = e.message
        raise
    return jsonify(charge=result)


# ------------------------------------------------------------------ frontend
@app.get("/", defaults={"path": ""})
@app.get("/<path:path>")
def spa(path):
    if path.startswith("api/"):
        raise ApiError("Not found.", 404)
    if not os.path.isdir(DIST_DIR):
        return ("Frontend not built yet. Run `npm install && npm run build` in frontend/ "
                "(or `npm run dev` and open the Vite URL)."), 200
    target = os.path.join(DIST_DIR, path)
    if path and os.path.isfile(target):
        return send_from_directory(DIST_DIR, path)
    return send_from_directory(DIST_DIR, "index.html")


if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 5000)), debug=False, threaded=True)
