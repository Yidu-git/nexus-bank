# Nexus Bank

A small full-stack banking app.

- **Frontend**: React (Vite), in `frontend/`
- **Backend**: Python + Flask JSON API, in `backend/app.py`
- **Database**: a JSON file, `backend/data/nexus.json` (If the file does not exist, it will be created on first run. Test data is included.)

# Video

(Video)[Video.mp4]

## Startup production(one server)

```bash
cd nexus/frontend
npm install
npm run build

cd ../backend
pip install -r requirements.txt
python app.py
```

Open **http://localhost:5000** (not 127.0.0.1: browsers only allow fingerprint prompts on `localhost` or https), choose **Open account**, and sign up.

## DevStart (development)

Terminal 1: `cd backend && python app.py`
Terminal 2: `cd frontend && npm run dev` and open the Vite URL (it proxies `/api` to Flask).

## Features

- Registration and sign-in (hashed passwords, expiring session tokens)
- Checking and savings accounts with unique account numbers (up to 5 each user)
- Deposit, withdraw, and transfer to any Nexus account number
- Per-account transaction history with running balance
- Left side menu (hover the left edge, or tap the edge / menu button) to pick what to do
- Dark and light mode, remembered per browser
- Bluetooth Pay: pick a nearby Bluetooth device (Web Bluetooth, Chrome/Edge on https or localhost) and pay a Nexus account
- **Fingerprint Pay** (company use): customers register their fingerprint at sign-up; a business picks prices on a phone and the customer pays by tapping the fingerprint reader on a Mac (see below)

## Fingerprint Pay

Two devices, one business login:

| Device | Does | Where in the app |
|---|---|---|
| **Phone** | Price selector: tap items / type an amount, press *Charge* | Menu > Business > *Price selector* |
| **Mac** (Touch ID) | Fingerprint terminal: customer taps, payment goes through | Menu > Business > *Fingerprint terminal* > *Start accepting payments* |

**Setting it up**

1. Create the business once: Menu > Business > set a name, the account that receives money, and a price list.
2. Customers create an account (on any device). Right after sign-up Nexus asks them to set up their fingerprint: **Use my phone's fingerprint** (scan the QR code with their phone and approve with its fingerprint, so nothing needs to be enrolled on the Mac) or **Use this device's fingerprint** (Touch ID / the phone they're on). They can add more later under Menu > Fingerprint Pay.
3. On the Mac: sign in as the business, open *Fingerprint terminal*, press *Start accepting payments*. Use Chrome, Edge or Safari at `http://localhost:5000`.
4. On the phone (same Wi-Fi as the Mac): start the server with `HOST=0.0.0.0 python app.py`, open `http://<mac-ip>:5000` on the phone and sign in as the same business. The phone only needs the price selector, which needs no fingerprint, so plain http works. Only do this on a network you trust; use https for anything real.
5. Pick a price on the phone and press *Charge*. The Mac asks for a fingerprint right away; one tap pays. Both screens show **Paid**.

**How it works / what is safe**

- It uses WebAuthn passkeys (Touch ID). The fingerprint never leaves the Mac's secure chip; Nexus stores only a public key. Each tap signs a one-time challenge, and the signature says *which* customer it is, so no account number is typed.
- The server (not the phone or browser) works out the price, checks the signature, origin, one-time challenge and "fingerprint was verified", then moves the money in one all-or-nothing step.
- Each customer has a **per-payment limit** (default ETB 5,000, editable under Fingerprint Pay) and chooses which account is charged.
- A charge waits 5 minutes for a fingerprint, and a business has one open charge at a time.
- Each customer's own device does the fingerprint check, so many customers can use one terminal and each pays from their own account. A website can't read fingerprints; the device only says "an enrolled finger approved this". At the terminal, Chrome shows a phone prompt: choose the paired phone (or scan the QR code the first time) and approve on the phone.
- Config: `NEXUS_RP_ID` (default `localhost`), `NEXUS_ORIGINS` (comma list, default `http://localhost:5000,http://localhost:5173`), `HOST`, `PORT`. When you move to a real https domain, set these to it; fingerprints registered on `localhost` must then be registered again.
- Tests: `cd backend && python test_fingerprint.py` (uses a software fingerprint sensor).

## API (all JSON)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/register` | Create customer + checking account |
| POST | `/api/login` | Returns a session token |
| POST | `/api/logout` | End session |
| GET | `/api/me` | Current user |
| GET/POST | `/api/accounts` | List / open an account |
| GET | `/api/accounts/<id>/transactions` | History |
| POST | `/api/deposit`, `/api/withdraw` | `{account_id, amount, note}` |
| POST | `/api/transfer` | `{from_account_id, to_account_number, amount, note}` |
| POST | `/api/bluetooth-pay` | `{account_id, to_account_number, amount, device_name}` |

Fingerprint Pay and business routes:

| Method | Path | Purpose |
|---|---|---|
| GET / PUT | `/api/fingerprint`, `/api/fingerprint/settings` | Registered fingerprints; pay-from account and limit |
| POST | `/api/fingerprint/register/options`, `/api/fingerprint/register/verify` | Register a fingerprint (WebAuthn) |
| DELETE | `/api/fingerprint/credentials/<id>` | Remove one |
| GET / PUT | `/api/merchant` | Business name, receiving account, price list |
| POST | `/api/merchant/charges` | Phone: create a charge `{items:[{id,qty}], custom_amount}` |
| GET / POST | `/api/merchant/charges/<id>`, `.../cancel` | Charge status / cancel |
| GET | `/api/merchant/terminal` | Mac: the latest charge |
| POST | `/api/pay/fingerprint/options`, `/api/pay/fingerprint/verify` | Mac: ask for a fingerprint and settle the payment |

Authenticated routes need `Authorization: Bearer <token>`.

## How the JSON database works

- All data (users, accounts, transactions, sessions) lives in one JSON document.
- Every change runs on a copy and is saved with an atomic file swap, so a failed
  transfer changes nothing and a crash can't leave a half-written file.
- Money is stored as integer cents. Session tokens are stored only as hashes.
- Run **one** server process only (the file is not safe for several processes).

## Before using this for anything real

This is a learning/demo project, not a production bank. A JSON file doesn't scale
or handle concurrent writers well; a real system would use PostgreSQL, HTTPS,
login rate limiting, audit logging, compliance checks, and a security review.
Don't put real money or real customer data in it.
