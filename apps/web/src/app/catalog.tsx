"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "@/lib/api";
import { formatBaht } from "@/lib/money";
import type { Product } from "@/lib/types";

const REFRESH_MS = 15_000;

export function useProducts(initial: Product[] | null) {
  const [products, setProducts] = useState<Product[] | null>(initial);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await api<{ items: Product[] }>("/products");
      setProducts(body.items);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  return { products, error, reload: load };
}

export function Catalog({ initialProducts }: { initialProducts: Product[] | null }) {
  const { products, error, reload } = useProducts(initialProducts);

  if (!products) {
    if (error) {
      return (
        <div className="alert alert-error" role="alert">
          <p>โหลดรายการสินค้าไม่สำเร็จ: {error}</p>
          <button type="button" className="btn btn-secondary" onClick={reload}>
            ลองโหลดอีกครั้ง
          </button>
        </div>
      );
    }
    return (
      <div className="grid" aria-busy="true" aria-label="กำลังโหลดสินค้า">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card">
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        ))}
      </div>
    );
  }

  if (products.length === 0) {
    return <p className="card">ยังไม่มีสินค้าเปิดขายตอนนี้ กลับมาดูใหม่ภายหลัง</p>;
  }

  return (
    <>
      {error && (
        <p className="alert alert-warning small" role="status">
          อัปเดตสต็อกล่าสุดไม่สำเร็จ ข้อมูลที่เห็นอาจไม่ใช่ล่าสุด
        </p>
      )}
      <ul className="grid list-unstyled" aria-label="สินค้า">
        {products.map((product) => (
          <li key={product.sku} className="card stack">
            <h2>{product.name}</h2>
            <p className="price">{formatBaht(product.price_satang)}</p>
            <ProductLimits product={product} />
            {product.stock === 0 ? (
              <span className="btn" aria-disabled="true">
                สินค้าหมด
              </span>
            ) : (
              <Link className="btn" href={`/checkout?sku=${encodeURIComponent(product.sku)}`}>
                ซื้อ {product.name}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function ProductLimits({ product }: { product: Product }) {
  return (
    <div className="small">
      {product.stock !== null && (
        <p className="flash">
          {product.stock > 0 ? `Flash sale เหลือ ${product.stock} ชิ้น` : "หมดแล้ว"}
          <span className="muted"> (อัปเดตทุก 15 วินาที อาจไม่ตรงทันที)</span>
        </p>
      )}
      {product.max_qty_per_order !== null && <p className="muted">จำกัด {product.max_qty_per_order} ชิ้นต่อออเดอร์</p>}
      {product.max_qty_per_email !== null && <p className="muted">จำกัด {product.max_qty_per_email} ชิ้นต่ออีเมล</p>}
    </div>
  );
}
