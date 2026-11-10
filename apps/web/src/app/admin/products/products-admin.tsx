"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, describeError } from "@/lib/api";
import { formatBaht, formatSatang, parseBahtToSatang } from "@/lib/money";
import type { AdminProduct } from "@/lib/types";
import { hasRole, useAdminSession } from "@/lib/use-admin";

const MAX_STOCK = 1_000_000;

/**
 * superadmin only. The API checks the role on every call; this page only hides itself.
 * Names are rendered as React text, never as HTML (spec 8.4).
 */
export function ProductsAdmin() {
  // The admin shell only renders pages when signed in.
  const { identity } = useAdminSession();
  if (!hasRole(identity, "superadmin")) {
    return (
      <p className="alert alert-error" role="alert">
        หน้านี้สำหรับสิทธิ์ superadmin เท่านั้น <Link href="/admin">กลับหน้าออเดอร์</Link>
      </p>
    );
  }
  return <ProductTable />;
}

function ProductTable() {
  const [products, setProducts] = useState<AdminProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProducts((await api<{ items: AdminProduct[] }>("/admin/products")).items);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <div className="stack">
      <p>
        <Link href="/admin">← กลับหน้าออเดอร์</Link>
      </p>
      <p className="alert alert-info">
        ราคาใหม่ใช้กับออเดอร์ที่สร้างหลังบันทึกเท่านั้น ออเดอร์เดิมคงราคาเดิม หน้าแคตตาล็อกอาจใช้เวลาถึง 15
        วินาทีจึงแสดงค่าใหม่
      </p>
      {error && (
        <div className="alert alert-error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn-secondary btn-small" onClick={load}>
            ลองอีกครั้ง
          </button>
        </div>
      )}
      {notice && (
        <p className="alert alert-success" role="status">
          {notice}
        </p>
      )}
      {products === null && !error && <p aria-busy="true">กำลังโหลดสินค้า…</p>}
      {products?.map((product) => (
        <ProductRow
          key={`${product.sku}-${product.updated_at}`}
          product={product}
          onSaved={(saved) => {
            setProducts((list) => list?.map((p) => (p.sku === saved.sku ? saved : p)) ?? null);
            setNotice(`บันทึก ${saved.sku} แล้ว`);
          }}
          onStale={load}
        />
      ))}
    </div>
  );
}

function ProductRow({
  product,
  onSaved,
  onStale,
}: {
  product: AdminProduct;
  onSaved: (product: AdminProduct) => void;
  onStale: () => void;
}) {
  const [name, setName] = useState(product.name);
  const [price, setPrice] = useState(formatSatang(product.price_satang));
  const [stock, setStock] = useState(product.stock === null ? "" : String(product.stock));
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = product.sku.toLowerCase();
  const errorId = `${id}-error`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body: Record<string, unknown> = {};
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) {
      setFieldError("ชื่อสินค้าต้องมี 1–120 ตัวอักษร");
      return;
    }
    if (trimmed !== product.name) body.name = trimmed;
    const satang = parseBahtToSatang(price);
    if (satang === null || satang <= 0) {
      setFieldError("กรอกราคาเป็นบาท เช่น 349 หรือ 349.50 (ทศนิยมไม่เกิน 2 ตำแหน่ง มากกว่า 0)");
      return;
    }
    if (satang !== product.price_satang) body.price_satang = satang;
    if (product.stock !== null) {
      if (!/^[0-9]{1,7}$/.test(stock.trim()) || Number(stock.trim()) > MAX_STOCK) {
        setFieldError(`สต็อกต้องเป็นจำนวนเต็ม 0–${MAX_STOCK.toLocaleString("th-TH")}`);
        return;
      }
      const next = Number(stock.trim());
      if (next !== product.stock) {
        body.stock = next;
        body.expected_stock = product.stock;
      }
    }
    if (Object.keys(body).length === 0) {
      setFieldError("ยังไม่มีอะไรเปลี่ยน");
      return;
    }
    setBusy(true);
    setFieldError(null);
    try {
      onSaved(await api<AdminProduct>(`/admin/products/${encodeURIComponent(product.sku)}`, { method: "PATCH", body }));
    } catch (err) {
      setFieldError(describeError(err));
      if (err instanceof ApiError && err.code === "STOCK_CHANGED") onStale();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={onSubmit} noValidate aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>
        {product.sku} <span className="muted">· {product.name}</span>
      </h2>
      <p className="muted">
        ราคาปัจจุบัน {formatBaht(product.price_satang)} · สต็อก{" "}
        {product.stock === null ? "ไม่จำกัด" : product.stock.toLocaleString("th-TH")}
      </p>
      <div className="grid">
        <div className="field">
          <label htmlFor={`${id}-name`}>ชื่อสินค้า</label>
          <input
            id={`${id}-name`}
            className="input"
            maxLength={120}
            value={name}
            aria-describedby={fieldError ? errorId : undefined}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-price`}>ราคา (บาท รวม VAT)</label>
          <input
            id={`${id}-price`}
            className="input"
            inputMode="decimal"
            value={price}
            aria-describedby={fieldError ? errorId : undefined}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-stock`}>สต็อกคงเหลือ</label>
          {product.stock === null ? (
            <input id={`${id}-stock`} className="input" value="ไม่จำกัด" disabled />
          ) : (
            <input
              id={`${id}-stock`}
              className="input"
              inputMode="numeric"
              value={stock}
              aria-describedby={fieldError ? errorId : undefined}
              onChange={(e) => setStock(e.target.value)}
            />
          )}
        </div>
      </div>
      {fieldError && (
        <p id={errorId} className="error-text" role="alert">
          {fieldError}
        </p>
      )}
      <div>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "กำลังบันทึก…" : "บันทึก"}
        </button>
      </div>
    </form>
  );
}
