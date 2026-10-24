const TOKEN_KEY = "nexus_token";

export const getToken = () => sessionStorage.getItem(TOKEN_KEY);
export const setToken = (t) =>
  t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY);

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }

  if (res.status === 401 && token) onUnauthorized();
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
