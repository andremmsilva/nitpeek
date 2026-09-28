const boot = JSON.parse(document.getElementById("nitpeek-data")!.textContent || "{}");
export const BOOT: { token: string; host: string; demo: boolean; settings: any } = boot;
const headers = { "X-Nitpeek-Token": BOOT.token };

async function parse(response: Response) {
  const body = await response.json().catch(() => ({ error: "Disconnected" }));
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

export const get = (path: string, params: Record<string, string> = {}) =>
  fetch(path + (Object.keys(params).length ? "?" + new URLSearchParams(params) : ""), { headers }).then(parse);

export const post = (path: string, body: unknown = {}) =>
  fetch(path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(parse);

export const notifyClosed = () => {
  try { fetch("/api/review/closed", { method: "POST", headers, keepalive: true }); } catch {}
};
