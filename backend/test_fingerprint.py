"""Run: python test_fingerprint.py  (software fingerprint sensor + temp database)."""
import hashlib, json, os, struct, sys, tempfile, secrets
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["NEXUS_DATA"] = os.path.join(tempfile.mkdtemp(), "t.json")
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes
import app as nx
from webauthn_lite import b64url, b64url_decode

def cbor(v):
    def head(m, n):
        if n < 24: return bytes([m<<5|n])
        if n < 256: return bytes([m<<5|24, n])
        if n < 65536: return bytes([m<<5|25]) + n.to_bytes(2,"big")
        return bytes([m<<5|26]) + n.to_bytes(4,"big")
    if isinstance(v, int): return head(0, v) if v >= 0 else head(1, -1-v)
    if isinstance(v, bytes): return head(2, len(v)) + v
    if isinstance(v, str): b = v.encode(); return head(3, len(b)) + b
    if isinstance(v, dict): return head(5, len(v)) + b"".join(cbor(k)+cbor(x) for k,x in v.items())
    raise TypeError

class Authenticator:
    """Software stand-in for a Mac's Touch ID passkey."""
    def __init__(self, origin="http://localhost:5000", rp="localhost"):
        self.keys = {}  # cred_id -> (privkey, user_handle)
        self.origin, self.rp = origin, rp
        self.count = 0
    def create(self, opts, uv=True):
        key = ec.generate_private_key(ec.SECP256R1()); cid = secrets.token_bytes(32)
        n = key.public_key().public_numbers()
        cose = cbor({1:2, 3:-7, -1:1, -2:n.x.to_bytes(32,"big"), -3:n.y.to_bytes(32,"big")})
        flags = 0x01 | (0x04 if uv else 0) | 0x40
        auth = hashlib.sha256(self.rp.encode()).digest() + bytes([flags]) + struct.pack(">I",0) + bytes(16) + struct.pack(">H",len(cid)) + cid + cose
        cd = json.dumps({"type":"webauthn.create","challenge":opts["challenge"],"origin":self.origin}).encode()
        self.keys[cid] = (key, b64url_decode(opts["user"]["id"]))
        return {"id":b64url(cid),"rawId":b64url(cid),"type":"public-key","response":{
            "clientDataJSON":b64url(cd),"attestationObject":b64url(cbor({"fmt":"none","attStmt":{},"authData":auth}))}}
    def get(self, opts, uv=True, origin=None, tamper=False, cid=None):
        cid = cid or list(self.keys)[-1]; key, handle = self.keys[cid]
        flags = 0x01 | (0x04 if uv else 0)
        self.count += 1
        auth = hashlib.sha256(self.rp.encode()).digest() + bytes([flags]) + struct.pack(">I", 0)
        cd = json.dumps({"type":"webauthn.get","challenge":opts["challenge"],"origin":origin or self.origin}).encode()
        sig = key.sign(auth + hashlib.sha256(cd).digest() + (b"x" if tamper else b""), ec.ECDSA(hashes.SHA256()))
        return {"id":b64url(cid),"rawId":b64url(cid),"type":"public-key","response":{
            "clientDataJSON":b64url(cd),"authenticatorData":b64url(auth),"signature":b64url(sig),"userHandle":b64url(handle)}}

c = nx.app.test_client()
def call(method, path, tok=None, **body):
    h = {"Authorization": "Bearer "+tok} if tok else {}
    r = getattr(c, method)("/api"+path, json=body or None, headers=h)
    return r.status_code, r.get_json()
def signup(name, email):
    assert call("post","/register",name=name,email=email,password="password123")[0]==201
    return call("post","/login",email=email,password="password123")[1]["token"]
def ok(cond, msg):
    print(("PASS " if cond else "FAIL ")+msg); 
    if not cond: sys.exit(1)

alice, shop, bob = signup("Alice","a@x.com"), signup("Corner Shop","s@x.com"), signup("Bob","b@x.com")
mac = Authenticator()

# --- enrolment at signup
s, opts = call("post","/fingerprint/register/options",alice)
ok(s==200 and opts["authenticatorSelection"]["userVerification"]=="required", "register options require fingerprint (UV)")
ok(call("post","/fingerprint/register/verify",alice,credential=mac.create(opts,uv=False))[0]==400, "enrolment without fingerprint verification is rejected")
s, opts = call("post","/fingerprint/register/options",alice)
cred = mac.create(opts)
ok(call("post","/fingerprint/register/verify",alice,credential=cred,label="MacBook")[0]==201, "fingerprint enrolled")
ok(call("post","/fingerprint/register/verify",alice,credential=cred)[0]==400, "enrolment challenge can't be replayed")
st = call("get","/fingerprint",alice)[1]
ok(len(st["credentials"])==1 and st["credentials"][0]["label"]=="MacBook", "credential listed")
bad = Authenticator(origin="http://evil.example"); s, o = call("post","/fingerprint/register/options",bob)
ok(call("post","/fingerprint/register/verify",bob,credential=bad.create(o))[0]==400, "wrong origin rejected at enrolment")
ok("http://localhost:5001" in nx.ORIGINS and "http://localhost.evil.com" not in nx.ORIGINS and "http://127.0.0.1:5000" not in nx.ORIGINS, "any localhost port allowed, look-alikes are not")

# --- money + merchant setup
aid = call("get","/accounts",alice)[1][0]["id"]; sid = call("get","/accounts",shop)[1][0]["id"]
call("post","/deposit",alice,account_id=aid,amount="100")
ok(call("post","/merchant/charges",shop,custom_amount="5")[0]==403, "non-merchant can't create charges")
s, m = call("put","/merchant",shop,name="Corner Shop",account_id=sid,items=[{"name":"Coffee","price":"3.50"},{"name":"Bagel","price":"2"}])
ok(s==200 and [i["price"] for i in m["items"]]==[3.5,2.0], "business + price list saved")
cof = m["items"][0]["id"]

# --- pay flow
s, ch = call("post","/merchant/charges",shop,items=[{"id":cof,"qty":2}],custom_amount="1.25")
ok(s==201 and ch["amount"]==8.25 and ch["status"]=="pending", "phone creates charge ETB 8.25 (server computes the price)")
ok(call("get","/merchant/terminal",shop)[1]["charge"]["id"]==ch["id"], "terminal sees the pending charge")
s, po = call("post","/pay/fingerprint/options",shop,charge_id=ch["id"])
ok(s==200 and [c["id"] for c in po["allowCredentials"]]==[cred["id"]] and po["allowCredentials"][0]["transports"], "terminal challenge names the Nexus fingerprint key (browser skips the passkey list)")
assertion = mac.get(po)
ok(call("post","/pay/fingerprint/verify",alice,credential=assertion,charge_id=ch["id"])[0]==400, "a different signed-in user can't use the terminal's challenge")
s, po = call("post","/pay/fingerprint/options",shop,charge_id=ch["id"])
r_=call("post","/pay/fingerprint/verify",shop,credential=mac.get(po,tamper=True)); print(r_); ok(r_[0]==400, "tampered signature rejected")
s, po = call("post","/pay/fingerprint/options",shop,charge_id=ch["id"])
ok(call("post","/pay/fingerprint/verify",shop,credential=mac.get(po,uv=False))[0]==400, "touch without fingerprint verification rejected")
s, po = call("post","/pay/fingerprint/options",shop,charge_id=ch["id"])
ok(call("post","/pay/fingerprint/verify",shop,credential=mac.get(po,origin="http://evil.example"))[0]==400, "wrong origin rejected")
s, po = call("post","/pay/fingerprint/options",shop,charge_id=ch["id"])
good = mac.get(po)
s, r = call("post","/pay/fingerprint/verify",shop,credential=good)
ok(s==200 and r["charge"]["status"]=="paid" and r["charge"]["customer"]=="Alice", "TAP -> paid, customer identified as Alice")
bal = lambda t,i: [a for a in call("get","/accounts",t)[1] if a["id"]==i][0]["balance"]
ok(bal(alice,aid)==91.75 and bal(shop,sid)==8.25, "balances moved: Alice 91.75, shop 8.25")
ok(call("post","/pay/fingerprint/verify",shop,credential=good)[0]==400, "same fingerprint response can't be replayed")
ok(call("get",f"/merchant/charges/{ch['id']}",shop)[1]["status"]=="paid", "phone sees paid")
hist_a = call("get",f"/accounts/{aid}/transactions",alice)[1][0]; hist_s = call("get",f"/accounts/{sid}/transactions",shop)[1][0]
ok(hist_a["kind"]=="fingerprint_out" and hist_s["kind"]=="fingerprint_in", "both sides have a history entry")

# --- declines
s, ch2 = call("post","/merchant/charges",shop,custom_amount="500")
s, po = call("post","/pay/fingerprint/options",shop,charge_id=ch2["id"])
s, r = call("post","/pay/fingerprint/verify",shop,credential=mac.get(po))
ok(s==402 and "Insufficient" in r["error"] or "limit" in r["error"], f"decline shown: {r['error']}")
ok(call("get",f"/merchant/charges/{ch2['id']}",shop)[1]["error"]==r["error"], "phone sees why it was declined")
ok(bal(alice,aid)==91.75, "decline moved no money")
call("put","/fingerprint/settings",alice,limit="50")
s, ch3 = call("post","/merchant/charges",shop,custom_amount="60"); s, po = call("post","/pay/fingerprint/options",shop,charge_id=ch3["id"])
s, r = call("post","/pay/fingerprint/verify",shop,credential=mac.get(po)); ok(s==402 and "limit" in r["error"], "per-payment limit enforced: "+r["error"])
ok(call("get",f"/merchant/charges/{ch2['id']}",shop)[1]["status"]=="cancelled", "new charge cancels the old open one")
# new charge cancel
s, ch4 = call("post","/merchant/charges",shop,custom_amount="1"); call("post",f"/merchant/charges/{ch4['id']}/cancel",shop)
ok(call("post","/pay/fingerprint/options",shop,charge_id=ch4["id"])[0]==409, "cancelled charge can't be paid")
# unknown fingerprint
stranger = Authenticator(); s, o = call("post","/fingerprint/register/options",bob)
# stranger has a key that was never registered with Nexus
s, ch5 = call("post","/merchant/charges",shop,custom_amount="1"); s, po = call("post","/pay/fingerprint/options",shop,charge_id=ch5["id"])
stranger.create({"challenge":"x","user":{"id":b64url(b"h")}}) if False else None
k = ec.generate_private_key(ec.SECP256R1()); cid = secrets.token_bytes(32); stranger.keys[cid]=(k,b"h")
s, r = call("post","/pay/fingerprint/verify",shop,credential=stranger.get(po,cid=cid)); ok(s==403, "unregistered fingerprint refused: "+r["error"])
# can't pay yourself
call("put","/merchant",alice,name="Alice Co",account_id=aid,items=[])
s, ch6 = call("post","/merchant/charges",alice,custom_amount="1"); s, po = call("post","/pay/fingerprint/options",alice,charge_id=ch6["id"])
s, r = call("post","/pay/fingerprint/verify",alice,credential=mac.get(po)); ok(s==402, "can't pay into own account: "+r["error"])
# cross-merchant isolation
ok(call("get",f"/merchant/charges/{ch5['id']}",alice)[0]==404, "other merchants can't see your charges")
# delete credential
cid_row = call("get","/fingerprint",alice)[1]["credentials"][0]["id"]
ok(call("delete",f"/fingerprint/credentials/{cid_row}",alice)[0]==200, "fingerprint removable")
s, po = call("post","/pay/fingerprint/options",shop,charge_id=ch5["id"]); s, r = call("post","/pay/fingerprint/verify",shop,credential=mac.get(po)); ok(s==403, "removed fingerprint no longer pays")

# --- two customers, each with their own phone: the right account is charged
bob_phone = Authenticator()
s, o = call("post","/fingerprint/register/options",bob,device="phone")
ok(o["authenticatorSelection"]["authenticatorAttachment"]=="cross-platform", "phone enrolment asks for the customer's own phone")
cr = bob_phone.create(o); cr["transports"]=["hybrid","internal"]
ok(call("post","/fingerprint/register/verify",bob,credential=cr,label="My phone")[0]==201, "Bob enrolled his phone")
bid = call("get","/accounts",bob)[1][0]["id"]; call("post","/deposit",bob,account_id=bid,amount="40")
call("put","/fingerprint/settings",alice,limit="5000"); call("post","/deposit",alice,account_id=aid,amount="100")
s, chb = call("post","/merchant/charges",shop,custom_amount="7")
s, po = call("post","/pay/fingerprint/options",shop,charge_id=chb["id"])
ok(len(po["allowCredentials"])>=1 and any(c["transports"]==["hybrid","internal"] for c in po["allowCredentials"]), "terminal lists every customer's key with its transport")
a_before = bal(alice,aid)
s, r = call("post","/pay/fingerprint/verify",shop,credential=bob_phone.get(po))
ok(s==200 and r["charge"]["customer"]=="Bob" and bal(bob,bid)==33 and bal(alice,aid)==a_before, "Bob's phone charges Bob only, not Alice")
print("ALL BACKEND TESTS PASSED")
