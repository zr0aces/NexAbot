import { Fault } from "./model";
export async function request(
  url: string,
  init: RequestInit = {},
  vendor = "GOOGLE",
) {
  let r: Response;
  try {
    r = await fetch(url, {
      redirect: "error",
      ...init,
      signal: AbortSignal.timeout(90000),
    });
  } catch {
    throw new Fault("NETWORK", "Network timeout or connection failure.", true);
  }
  if (r.ok) return r;
  const text = (await r.text().catch(() => "")).slice(0, 2048);
  const after = r.headers.get("retry-after") ?? "0",
    delay =
      (/^\d+$/.test(after)
        ? Number(after) * 1000
        : Date.parse(after) - Date.now()) || 0;
  if (/album.*(full|maximum|limit)|20000|20,000/i.test(text))
    throw new Fault(
      "ALBUM_CAPACITY",
      "Album is full. No overflow album was created.",
    );
  if (
    /storage quota|storage.*full|out of storage|insufficient storage/i.test(
      text,
    )
  )
    throw new Fault(
      "GOOGLE_STORAGE",
      "Free space in your Google account before retrying.",
    );
  if (r.status === 429)
    throw new Fault(
      vendor + "_RATE_LIMIT",
      "Provider rate limit. Retry scheduled.",
      true,
      delay,
    );
  if (r.status === 401 || r.status === 403 || /invalid_grant/.test(text))
    throw new Fault(
      vendor + "_AUTH",
      "Check credentials and reconnect " + vendor + ".",
    );
  throw new Fault(
    vendor + "_" + r.status,
    vendor + " returned HTTP " + r.status,
    r.status >= 500 || r.status === 408,
    delay,
  );
}
