// Thin wrappers around the browser's WebAuthn API (Touch ID on a Mac).
// The fingerprint itself never leaves the Mac: the browser only hands back a signature.

const toBuffer = (b64u) => {
  const pad = "=".repeat((4 - (b64u.length % 4)) % 4);
  const bin = atob(b64u.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
};

const toB64u = (buf) => {
  let bin = "";
  new Uint8Array(buf).forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// Browsers refuse fingerprint prompts on plain http, and on bare IP addresses like 127.0.0.1.
const hostIsIp = /^\[|^\d+\.\d+\.\d+\.\d+$/.test(location.hostname);
export const fingerprintSupported =
  typeof window !== "undefined" && window.isSecureContext && "PublicKeyCredential" in window && !hostIsIp;

export const unsupportedReason = () => {
  if (hostIsIp) return `Open this site as http://localhost:${location.port || 80} instead of ${location.hostname} \u2014 browsers only allow fingerprint prompts on localhost or https.`;
  if (!window.isSecureContext) return "Fingerprint needs https (or http://localhost). This page is not secure: " + location.origin;
  if (!("PublicKeyCredential" in window)) return "This browser window has no WebAuthn (passkey) support. Try a normal Chrome/Safari window (not an embedded preview or a restricted profile).";
  return "Fingerprint isn't available here.";
};

// Turn the browser's errors into something a customer can act on.
export function friendlyError(ex) {
  switch (ex?.name) {
    case "NotAllowedError": return "Fingerprint cancelled or timed out.";
    case "AbortError": return "Fingerprint scan stopped.";
    case "InvalidStateError": return "This device already has a fingerprint registered for Nexus.";
    case "SecurityError": return unsupportedReason();
    case "NotSupportedError": return "This device can't use a fingerprint here.";
    default: return ex?.message || "Something went wrong.";
  }
}

// options come from the server (see /api/fingerprint/register/options)
export async function createFingerprintKey(options) {
  const publicKey = {
    ...options,
    challenge: toBuffer(options.challenge),
    user: { ...options.user, id: toBuffer(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: toBuffer(c.id) })),
  };
  const cred = await navigator.credentials.create({ publicKey });
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    transports: cred.response.getTransports ? cred.response.getTransports() : [],
    response: {
      clientDataJSON: toB64u(cred.response.clientDataJSON),
      attestationObject: toB64u(cred.response.attestationObject),
    },
  };
}

// Ask for a fingerprint. No account is named: the key that answers says who the customer is.
export async function scanFingerprint(options, signal) {
  const publicKey = {
    ...options,
    challenge: toBuffer(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: toBuffer(c.id) })),
  };
  const cred = await navigator.credentials.get({ publicKey, signal });
  const r = cred.response;
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64u(r.clientDataJSON),
      authenticatorData: toB64u(r.authenticatorData),
      signature: toB64u(r.signature),
      userHandle: r.userHandle ? toB64u(r.userHandle) : null,
    },
  };
}
