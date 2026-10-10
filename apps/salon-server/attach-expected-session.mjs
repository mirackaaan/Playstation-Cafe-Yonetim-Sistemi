export async function attachExpectedSession(baseUrl, token, pathname, method, body) {
  if (method !== "POST" || !token) return body;
  const match = String(pathname).match(/^\/api\/devices\/(\d+)\/(stop|transfer|undo|checkout-hold|checkout-release)$/);
  if (!match) return body;
  if (body?.expectedSessionId != null) return body;
  const response = await fetch(`${baseUrl}/api/devices`, { headers: { authorization: `Bearer ${token}` } });
  const devices = await response.json();
  const device = devices.find(item => item.id === Number(match[1]));
  const expectedSessionId = match[2] === "undo" ? device?.lastClosedSessionId : device?.activeSession?.id;
  if (!expectedSessionId) return body;
  return { ...(body && typeof body === "object" ? body : {}), expectedSessionId };
}
