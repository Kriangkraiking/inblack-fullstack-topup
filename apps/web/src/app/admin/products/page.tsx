import type { Metadata } from "next";
import { ProductsAdmin } from "./products-admin";

// noindex comes from the admin layout as well; repeated so this page cannot lose it.
export const metadata: Metadata = { title: "จัดการสินค้า", robots: { index: false, follow: false } };

export default function AdminProductsPage() {
  return (
    <>
      <h1>ผู้ดูแลระบบ: จัดการสินค้า</h1>
      <ProductsAdmin />
    </>
  );
}
