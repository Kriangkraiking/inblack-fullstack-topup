import type { Metadata } from "next";
import { fetchProductsOnServer } from "@/lib/server-api";
import { Catalog } from "./catalog";

export const metadata: Metadata = {
  title: "เติมเกม เพชร Monthly Pass และสกินลิมิเต็ด",
  alternates: { canonical: "/" },
};

/**
 * Server Component: renders the product list into the HTML (good for SEO and
 * first paint), then hands it to the Catalog client island, which refreshes
 * stock from the browser. If the API is down the island loads it on its own.
 */
export default async function HomePage() {
  const products = await fetchProductsOnServer();
  return (
    <div className="stack">
      <h1>เติมเกมกับ InBlack</h1>
      <p className="muted">
        เลือกสินค้า กรอก Game UID แล้วชำระเงิน ระบบจะเติมให้อัตโนมัติและแจ้งสถานะทุกขั้นตอน
      </p>
      <Catalog initialProducts={products} />
    </div>
  );
}
