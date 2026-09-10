export type SafeJsonResult<T = unknown> =
  | { ok: true; data: T; text: string; contentType: string; status: number }
  | { ok: false; error: string; bodyPreview: string; bodyEmpty: boolean; contentType: string; status: number };

const preview = (value: string) => value.length > 500 ? `${value.slice(0, 500)}…` : value;

/** Reads a response once and never throws merely because its body is empty or non-JSON. */
export async function readJsonResponse<T = unknown>(response: Response): Promise<SafeJsonResult<T>> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  const bodyEmpty = text.trim().length === 0;
  const bodyPreview = bodyEmpty ? '<empty>' : preview(text);
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, bodyPreview, bodyEmpty, contentType, status: response.status };
  if (bodyEmpty) return { ok: false, error: 'empty JSON response', bodyPreview, bodyEmpty, contentType, status: response.status };
  try {
    return { ok: true, data: JSON.parse(text) as T, text, contentType, status: response.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'invalid JSON', bodyPreview, bodyEmpty, contentType, status: response.status };
  }
}

export function responseFailureMessage(result: Extract<SafeJsonResult, { ok: false }>, prefix = 'API response') {
  return `${prefix}: ${result.error}; status=${result.status}; content-type=${result.contentType || '<missing>'}; body=${result.bodyPreview}`;
}
