const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

export class HttpBodyError extends Error {
  constructor(code, statusCode) {
    super(code === "BODY_TOO_LARGE" ? "request body is too large" : "invalid JSON body");
    this.name = "HttpBodyError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function contentLengthValues(request) {
  const values = [];
  const rawHeaders = Array.isArray(request.rawHeaders) ? request.rawHeaders : [];

  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === "content-length") {
      values.push(String(rawHeaders[index + 1] ?? ""));
    }
  }

  if (values.length === 0) {
    const header = request.headers?.["content-length"];
    if (Array.isArray(header)) {
      values.push(...header.map(String));
    } else if (header !== undefined) {
      values.push(...String(header).split(","));
    }
  }

  return values.map((value) => value.trim());
}

function validateLimit(limitBytes) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) {
    throw new RangeError("limitBytes must be a positive safe integer");
  }
}

function declaredLength(request, limitBytes) {
  const values = contentLengthValues(request);
  if (values.length > 1) {
    throw new HttpBodyError("INVALID_JSON_BODY", 400);
  }
  if (values.length === 0) {
    return undefined;
  }
  if (!/^\d+$/.test(values[0])) {
    throw new HttpBodyError("INVALID_JSON_BODY", 400);
  }

  const length = Number(values[0]);
  if (!Number.isSafeInteger(length)) {
    throw new HttpBodyError("INVALID_JSON_BODY", 400);
  }
  if (length > limitBytes) {
    throw new HttpBodyError("BODY_TOO_LARGE", 413);
  }
  return length;
}

function readBounded(request, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let settled = false;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback(value);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > limitBytes) {
        finish(reject, new HttpBodyError("BODY_TOO_LARGE", 413));
        request.resume?.();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks).toString("utf8"));
    const onError = () => finish(reject, new HttpBodyError("INVALID_JSON_BODY", 400));
    const onAborted = () => finish(reject, new HttpBodyError("INVALID_JSON_BODY", 400));

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

export async function readJsonBody(
  request,
  { limitBytes = DEFAULT_BODY_LIMIT_BYTES } = {},
) {
  validateLimit(limitBytes);
  const expectedLength = declaredLength(request, limitBytes);
  const text = await readBounded(request, limitBytes);

  if (expectedLength !== undefined && Buffer.byteLength(text) !== expectedLength) {
    throw new HttpBodyError("INVALID_JSON_BODY", 400);
  }
  if (text.length === 0) {
    throw new HttpBodyError("INVALID_JSON_BODY", 400);
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpBodyError("INVALID_JSON_BODY", 400);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpBodyError("INVALID_JSON_BODY", 400);
  }
  return value;
}
