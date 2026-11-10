"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { formatBaht } from "@/lib/money";
import type { Product } from "@/lib/types";
import { useProducts } from "@/lib/use-products";

type Group = "diamond" | "pass" | "flash" | "other";

const GROUP_LABEL: Record<Group, string> = {
  diamond: "เพชร",
  pass: "Pass รายเดือน",
  flash: "Flash sale",
  other: "อื่น ๆ",
};

/**
 * Which category chip a product falls under. Uses `category` when a newer API
 * sends it; otherwise guesses from the SKU and stock (display only).
 */
function groupOf(product: Product): { key: string; label: string; art: Group } {
  const art: Group =
    product.stock !== null ? "flash" : product.sku.startsWith("DIAMOND") ? "diamond" : product.sku.includes("PASS") ? "pass" : "other";
  const category = product.category?.trim();
  return category ? { key: `c:${category}`, label: category, art } : { key: art, label: GROUP_LABEL[art], art };
}

export function Catalog({ initialProducts, hero }: { initialProducts: Product[] | null; hero?: ReactNode }) {
  const { products, error, reload } = useProducts(initialProducts);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string>("all");

  const groups = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of products ?? []) {
      const g = groupOf(p);
      if (!seen.has(g.key)) seen.set(g.key, g.label);
    }
    return [...seen.entries()];
  }, [products]);

  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("th");
    return (products ?? []).filter(
      (p) =>
        (group === "all" || groupOf(p).key === group) &&
        (!q || p.name.toLocaleLowerCase("th").includes(q) || p.sku.toLocaleLowerCase("th").includes(q)),
    );
  }, [products, query, group]);

  return (
    <div className="stack-lg">
      <form className="search-bar" role="search" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="catalog-search" className="sr-only">
          ค้นหาสินค้า
        </label>
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2.2" />
          <path d="m16.5 16.5 4 4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
        <input
          id="catalog-search"
          className="search-bar__input"
          type="search"
          placeholder="ค้นหาเกมหรือสินค้า"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </form>

      {hero}

      <CatalogBody
        products={products}
        visible={visible}
        error={error}
        reload={reload}
        groups={groups}
        group={group}
        setGroup={setGroup}
        filtered={query.trim() !== "" || group !== "all"}
      />
    </div>
  );
}

function CatalogBody({
  products,
  visible,
  error,
  reload,
  groups,
  group,
  setGroup,
  filtered,
}: {
  products: Product[] | null;
  visible: Product[];
  error: string | null;
  reload: () => void;
  groups: [string, string][];
  group: string;
  setGroup: (g: string) => void;
  filtered: boolean;
}) {
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
      <div className="product-grid" aria-busy="true" aria-label="กำลังโหลดสินค้า">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="product-card">
            <div className="product-card__art skeleton" />
            <div className="product-card__body">
              <div className="skeleton" />
              <div className="skeleton" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (products.length === 0) {
    return <p className="card empty">ยังไม่มีสินค้าเปิดขายตอนนี้ กลับมาดูใหม่ภายหลัง</p>;
  }

  return (
    <section className="stack" aria-labelledby="products-heading">
      <h2 id="products-heading" className="section-title">
        สินค้าทั้งหมด
      </h2>
      <div className="chips" role="group" aria-label="หมวดหมู่">
        {[["all", "ทั้งหมด"] as [string, string], ...groups].map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="chip"
            aria-pressed={group === key}
            onClick={() => setGroup(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <p className="alert alert-warning small" role="status">
          อัปเดตสต็อกล่าสุดไม่สำเร็จ ข้อมูลที่เห็นอาจไม่ใช่ล่าสุด
        </p>
      )}

      <p className="sr-only" aria-live="polite">
        {filtered ? `พบ ${visible.length} รายการ` : ""}
      </p>

      {visible.length === 0 ? (
        <p className="card empty">ไม่พบสินค้าที่ตรงกับคำค้นหรือหมวดที่เลือก</p>
      ) : (
        <ul className="product-grid list-unstyled" aria-label="สินค้า">
          {visible.map((product) => (
            <li key={product.sku} className="product-card">
              <div className={`product-card__art art-${groupOf(product).art}`} aria-hidden="true">
                <ProductIcon art={groupOf(product).art} />
                {product.stock !== null && <span className="ribbon">FLASH</span>}
              </div>
              <div className="product-card__body">
                <h3 className="product-card__name">{product.name}</h3>
                {product.description && <p className="small muted">{product.description}</p>}
                <p className="price">{formatBaht(product.price_satang)}</p>
                <ProductLimits product={product} />
                <div className="product-card__cta">
                  {product.stock === 0 ? (
                    <span className="btn btn-block" aria-disabled="true">
                      สินค้าหมด
                    </span>
                  ) : (
                    <Link className="btn btn-block" href={`/checkout?sku=${encodeURIComponent(product.sku)}`}>
                      ซื้อ {product.name}
                    </Link>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProductIcon({ art }: { art: Group }) {
  if (art === "diamond") {
    return (
      <svg viewBox="0 0 48 48" width="56" height="56">
        <path d="M14 8h20l8 10-18 22L6 18z" fill="#fff" />
        <path d="M6 18h36M18 8l-4 10 10 22 10-22-4-10" stroke="#c8102e" strokeWidth="2" fill="none" />
      </svg>
    );
  }
  if (art === "pass") {
    return (
      <svg viewBox="0 0 48 48" width="56" height="56">
        <rect x="6" y="12" width="36" height="24" rx="5" fill="#fff" />
        <path d="M30 12v24" stroke="#c8102e" strokeWidth="2" strokeDasharray="3 3" />
        <path d="M13 21h11M13 27h7" stroke="#16161a" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (art === "flash") {
    return (
      <svg viewBox="0 0 48 48" width="56" height="56">
        <path d="M27 4 10 27h12l-3 17 19-25H26z" fill="#fff" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 48 48" width="56" height="56">
      <circle cx="24" cy="24" r="16" fill="#fff" />
    </svg>
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
