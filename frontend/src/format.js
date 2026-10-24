export const money = (n) =>
  "ETB " + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const KIND_LABEL = {
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
  fingerprint_out: "Fingerprint Pay",
  fingerprint_in: "Fingerprint sale",
};

export const isCredit = (kind) => kind === "deposit" || kind === "transfer_in" || kind === "fingerprint_in";

export const formatDate = (iso) => iso.slice(0, 16).replace("T", " ") + " UTC";

export const cap = (s) => s[0].toUpperCase() + s.slice(1);
