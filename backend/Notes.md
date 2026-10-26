# Note
The backend was reformatted with AI to get rid of divergence between the front end and backend and to make minor security adjustments(A bit ironic but the point of this project is a proof of concept). Some dev tools (such as `fingerprint_test.py` and `webauth.py`) have also been updated with AI to better resemble production level code. Old dev tools may not be included or permanently removed/deprecated.

If you have attended the 2025/2026 INSA weekend training, you should know that werkzeug can have certain vulnerabilities leading to lateral access, wanna try it out?

# General discription

This repository consists of a simple backend (flask with + werkzeug sec) so don't expect this to replace real banks any time soon. Some features are missing so you can deposit as much money as you want but this app is mostly to implement the WebAuth feature. We would much appreciate feedback on the security of the backend. Please notify us (Either me(@Yidu-git) or Noah(@Noah2011-sol) ) of any WebAuth vulnerabilities you find.

## Encryption
Thanks to some feed back from the team, we've acknowledged that JSON web tokens are an insecure way of handling sessions. While it is simpler to implement, its advantages are small. We've instead implemented a session id system where multiple devices can have separate session IDs and access the site at any time under the time limit set by the variable `SESSION_HOURS` in `app.py`.

# Tests and tools
Automated tests are not a feature in the codebase yet, As such to test the fingerprint feature use the `test_fingerprint.py`. The `webauth.py` or `webauthn_lite.py`.

## Fingerprint test
The advantage of the fingerprint feature is that it uses the built in webauth passkey functionality included in every flagship device. And even if the device doesnt have a fingerprint sensor, the operating system should have a different way of web authentication through a modern browser. The `test_fingerprint.py` file creates a WebAuth key and tests if the website is responsive to the key. Additional tests can be added or removed.

After running:

```bash
python3 test_fingerprint.py
```
or
```bash
python test_fingerprint.py
```

A successful test should return :
```
PASS register options require fingerprint (UV)
PASS enrolment without fingerprint verification is rejected
PASS fingerprint enrolled
PASS enrolment challenge can't be replayed
PASS credential listed
PASS wrong origin rejected at enrolment
PASS any localhost port allowed, look-alikes are not
PASS non-merchant can't create charges
PASS business + price list saved
PASS phone creates charge ETB 8.25 (server computes the price)
PASS terminal sees the pending charge
PASS terminal challenge names the Nexus fingerprint key (browser skips the passkey list)
PASS a different signed-in user can't use the terminal's challenge
(400, {'error': 'Fingerprint could not be verified.'})
PASS tampered signature rejected
PASS touch without fingerprint verification rejected
PASS wrong origin rejected
PASS TAP -> paid, customer identified as Alice
PASS balances moved: Alice 91.75, shop 8.25
PASS same fingerprint response can't be replayed
PASS phone sees paid
PASS both sides have a history entry
PASS decline shown: Insufficient funds.
PASS phone sees why it was declined
PASS decline moved no money
PASS per-payment limit enforced: Over this fingerprint limit of ETB 50.00.
PASS new charge cancels the old open one
PASS cancelled charge can't be paid
PASS unregistered fingerprint refused: Fingerprint not recognised. Is it registered with a Nexus account?
PASS can't pay into own account: A business can't pay into its own account. Use a different customer account.
PASS other merchants can't see your charges
PASS fingerprint removable
PASS removed fingerprint no longer pays
PASS phone enrolment asks for the customer's own phone
PASS Bob enrolled his phone
PASS terminal lists every customer's key with its transport
PASS Bob's phone charges Bob only, not Alice
ALL BACKEND TESTS PASSED
```