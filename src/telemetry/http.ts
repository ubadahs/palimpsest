import {
  currentTraceSession,
  redactTrace,
  rethrowTraceError,
  safeTraceUrl,
  traceUrlSecrets,
  traceCheckpoint,
  traceOperation,
} from "./trace.js";

export type TraceFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const secretHeader = /^(authorization|proxy-authorization|x-api-key|cookie)$/i;
const usefulHeader =
  /^(content-type|content-length|retry-after|request-id|x-request-id|anthropic-version|anthropic-beta|x-palimpsest-.*|.*ratelimit.*)$/i;

function safeHeaders(headers: Headers, secrets: string[]) {
  return Object.fromEntries(
    [...headers]
      .filter(([name]) => usefulHeader.test(name))
      .map(([name, value]) => [name, redactTrace(value, secrets)]),
  );
}

async function requestBody(
  body: BodyInit | null | undefined,
  secrets: string[],
): Promise<unknown> {
  if (body == null) return null;
  if (typeof body === "string") {
    try {
      return redactTrace(JSON.parse(body), secrets);
    } catch {
      return redactTrace(body, secrets);
    }
  }
  if (body instanceof URLSearchParams)
    return redactTrace(Object.fromEntries(body), secrets);
  if (body instanceof FormData) {
    const entries = [];
    for (const [name, value] of body)
      entries.push([
        name,
        typeof value === "string"
          ? value
          : {
              filename: value.name,
              type: value.type,
              payload: currentTraceSession().bytes(
                new Uint8Array(await value.arrayBuffer()),
              ),
            },
      ]);
    return redactTrace(Object.fromEntries(entries), secrets);
  }
  if (body instanceof Blob)
    return currentTraceSession().bytes(
      new Uint8Array(await body.arrayBuffer()),
    );
  if (body instanceof ArrayBuffer)
    return currentTraceSession().bytes(new Uint8Array(body));
  if (ArrayBuffer.isView(body))
    return currentTraceSession().bytes(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
  throw new Error(
    "Streaming request bodies must be materialized before audited HTTP calls",
  );
}

/** Every actual network attempt passes here, including batch submission/polling. */
export async function tracedFetch(
  input: string | URL | Request,
  init?: RequestInit,
  fetcher: TraceFetch = (url, options) => globalThis.fetch(url, options),
): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const secrets = [...headers]
    .filter(([name]) => secretHeader.test(name))
    .flatMap(([, value]) => [value, value.replace(/^Bearer\s+/i, "")])
    .concat(traceUrlSecrets(url));
  currentTraceSession().protect(secrets);
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  return traceOperation(
    "http",
    `${method} ${safeTraceUrl(url)}`,
    { url: safeTraceUrl(url), method, headers: safeHeaders(headers, secrets) },
    async () => {
      const body =
        init?.body ??
        (input instanceof Request && input.body
          ? await input.clone().text()
          : undefined);
      traceCheckpoint("request_body", {
        payload: currentTraceSession().blob(await requestBody(body, secrets)),
      });
      let response: Response;
      try {
        response = await fetcher(input, init);
      } catch (error) {
        rethrowTraceError(error);
        // An error may echo credentials from its URL or headers.
        throw new Error(
          String(
            redactTrace(
              error instanceof Error ? error.message : String(error),
              secrets,
            ),
          ),
          { cause: error },
        );
      }
      traceCheckpoint("response_headers", {
        status: response.status,
        url: safeTraceUrl(response.url || url),
        headers: safeHeaders(response.headers, secrets),
      });
      // Save a complete response before handing it to SDK/schema parsing. A parse
      // failure or process exit afterward cannot discard a billable raw reply.
      const bytes = new Uint8Array(await response.clone().arrayBuffer());
      const type = response.headers.get("content-type") ?? "";
      let payload;
      if (/json|text|xml|javascript/i.test(type)) {
        const text = new TextDecoder().decode(bytes);
        let value: unknown = text;
        try {
          value = JSON.parse(text) as unknown;
        } catch {
          /* text/XML/JSONL */
        }
        payload = currentTraceSession().blob(redactTrace(value, secrets));
      } else payload = currentTraceSession().bytes(bytes);
      traceCheckpoint("response_body", {
        status: response.status,
        contentType: type,
        bytes: bytes.length,
        payload,
      });
      return response;
    },
  );
}
