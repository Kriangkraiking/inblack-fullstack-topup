/**
 * The browser calls the API (nginx on :8080) directly with the session cookie.
 * It is not proxied through the Next server, so the API's per-IP rate limits
 * see each customer's own address (ADR 0005).
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

export function apiUrl(path: string): string {
  return `${API_BASE_URL}/api/v1${path}`;
}

/** RFC 9457 problem body as the API sends it. */
export interface Problem {
  status: number;
  code: string;
  detail: string;
  title?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  /** Seconds from Retry-After on a 429, otherwise null. */
  readonly retryAfter: number | null;

  constructor(problem: Problem, retryAfter: number | null) {
    super(`${problem.code}: ${problem.detail}`);
    this.status = problem.status;
    this.code = problem.code;
    this.detail = problem.detail;
    this.retryAfter = retryAfter;
  }
}

/** A network failure or a 5XX: the same request may be sent again. */
export function isRetryable(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

interface ApiOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method: options.method ?? "GET",
      credentials: "include",
      cache: "no-store",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(
      { status: 0, code: "NETWORK_ERROR", detail: "ติดต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง" },
      null,
    );
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const body = (data ?? {}) as Partial<Problem>;
    const retryHeader = response.headers.get("Retry-After");
    const retryAfter = retryHeader && /^[0-9]+$/.test(retryHeader) ? Number(retryHeader) : null;
    throw new ApiError(
      {
        status: response.status,
        code: typeof body.code === "string" ? body.code : `HTTP_${response.status}`,
        detail: typeof body.detail === "string" ? body.detail : response.statusText,
      },
      retryAfter,
    );
  }
  return data as T;
}

const MESSAGES: Record<string, string> = {
  OUT_OF_STOCK: "สินค้าหมดหรือเหลือไม่พอสำหรับจำนวนที่เลือก",
  VOUCHER_EXHAUSTED: "โค้ดนี้ถูกใช้ครบจำนวนแล้ว",
  VOUCHER_NOT_FOUND: "ไม่พบโค้ดส่วนลดนี้",
  VOUCHER_INACTIVE: "โค้ดนี้ปิดใช้งานแล้ว",
  VOUCHER_MIN_SUBTOTAL: "ยอดสินค้ายังไม่ถึงขั้นต่ำของโค้ดนี้",
  PER_CUSTOMER_LIMIT: "อีเมลนี้ใช้สิทธิ์ครบแล้ว",
  PER_ORDER_LIMIT: "จำนวนเกินที่สั่งได้ต่อออเดอร์",
  IDEMPOTENCY_KEY_REUSED: "คำสั่งซื้อนี้ถูกส่งไปแล้วด้วยข้อมูลอื่น กรุณากดสั่งซื้ออีกครั้ง",
  VALIDATION_ERROR: "ข้อมูลไม่ถูกต้อง",
  ORDER_NOT_FOUND: "ไม่พบออเดอร์ที่ตรงกับเลขออเดอร์และอีเมลนี้",
  INVALID_ORDER_ID: "เลขออเดอร์ไม่ถูกต้อง",
  RATE_LIMITED: "ลองบ่อยเกินไป",
  OTP_LOCKED: "ใส่รหัสผิดหลายครั้ง บัญชีถูกล็อกชั่วคราว",
  OTP_INVALID: "รหัสไม่ถูกต้อง หมดอายุ หรือถูกใช้แล้ว",
  INVALID_CREDENTIALS: "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
  UNAUTHENTICATED: "กรุณาเข้าสู่ระบบ",
  FORBIDDEN: "สิทธิ์ของบัญชีนี้ทำรายการนี้ไม่ได้",
  CSRF_ORIGIN_MISMATCH: "คำขอถูกปฏิเสธเพราะมาจากต้นทางที่ไม่ได้รับอนุญาต",
  REFUND_EXCEEDS_PAID: "ยอดคืนเงินเกินยอดที่ชำระและยังไม่ได้คืน",
  ORDER_NOT_REFUNDABLE: "ออเดอร์สถานะนี้คืนเงินไม่ได้",
  ORDER_NOT_RETRYABLE: "ออเดอร์นี้สั่งเติมใหม่ไม่ได้",
  FULFILLMENT_ALREADY_QUEUED: "ออเดอร์นี้อยู่ในคิวเติมแล้ว",
  REFUND_IN_PROGRESS: "มีการคืนเงินค้างอยู่",
  INVALID_TRANSITION: "เปลี่ยนสถานะนี้ไม่ได้",
  NETWORK_ERROR: "ติดต่อเซิร์ฟเวอร์ไม่ได้",
  LOGIN_LOCKED: "ลองเข้าสู่ระบบผิดหลายครั้ง อีเมลนี้ถูกล็อกชั่วคราว",
  UNSUPPORTED_MEDIA_TYPE: "รูปแบบคำขอไม่ถูกต้อง",
  EMAIL_SEARCH_FORBIDDEN: "สิทธิ์ของบัญชีนี้ค้นหาได้ด้วยเลขออเดอร์เท่านั้น",
  PRODUCT_NOT_FOUND: "ไม่พบสินค้านี้",
  STOCK_CHANGED: "สต็อกเปลี่ยนไประหว่างแก้ไข (มีคนสั่งซื้อ) โหลดใหม่แล้วลองอีกครั้ง",
  STOCK_MODE_LOCKED: "สลับระหว่างสต็อกจำกัดและไม่จำกัดไม่ได้",
};

/** A Thai sentence for the problem, with the API's own detail kept for support. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return "เกิดข้อผิดพลาดที่ไม่คาดคิด กรุณาลองอีกครั้ง";
  if (error.status === 0) return error.detail;
  const base = MESSAGES[error.code] ?? (error.status >= 500 ? "ระบบขัดข้องชั่วคราว กรุณาลองอีกครั้ง" : "ทำรายการไม่สำเร็จ");
  const wait = error.retryAfter !== null ? ` รอ ${error.retryAfter} วินาทีแล้วลองใหม่` : "";
  return `${base}${wait} (${error.code}: ${error.detail})`;
}
