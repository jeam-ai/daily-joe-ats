/** Every browser request has a deadline, including downloads and response bodies. */
export async function clientFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
) {
  try {
    const timeout = AbortSignal.timeout(
      String(input).includes("/api/timekeeping?job=")
        ? 20000
        : String(input).includes("/api/intake")
          ? 240000
          : String(input).includes("/ai")
            ? 90000
            : String(input).includes("/resume") ||
                String(input).includes("/processing") ||
                String(input).includes("/api/timekeeping")
              ? 180000
              : 60000,
    );
    const response = await fetch(input, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        ...(typeof window !== "undefined"
          ? { "X-DJC-Dataset": sessionStorage.getItem("djc-dataset") || "real" }
          : {}),
      },
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
    // Buffer the body within the same deadline; stalled JSON/downloads also settle.
    const bytes = await response.arrayBuffer();
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw new Error("The request was cancelled.");
    if (error instanceof DOMException && error.name === "TimeoutError")
      throw new RequestError(
        "This request took too long. Refresh to check whether it completed before trying again.",
        408,
      );
    throw new RequestError(
      "Unable to reach Daily Joe Careers. Check your connection and try again.",
      0,
    );
  }
}
export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "RequestError";
  }
}
export async function requestJson<T = Record<string, unknown>>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await clientFetch(url, init);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data)
    throw new RequestError(
      data?.error ||
        "The service could not complete this request. Please try again.",
      response.status,
    );
  return data as T;
}
export async function downloadFile(
  url: string,
  filename: string,
  init?: RequestInit,
) {
  const response = await clientFetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      body.error || "The download could not be prepared. Please try again.",
    );
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
