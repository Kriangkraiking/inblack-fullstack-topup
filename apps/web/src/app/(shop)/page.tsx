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
 * The hero is server markup passed into the island as a prop, so it stays out
 * of the client bundle.
 */
export default async function HomePage() {
  const products = await fetchProductsOnServer();
  return <Catalog initialProducts={products} hero={<Hero />} />;
}

function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-heading">
      <div className="hero__text">
        <h1 id="hero-heading" className="hero__title">
          <span lang="en">
            ALL GAMES BY <span className="text-brand">INBLACK</span>
          </span>
          <span className="hero__title-th">เติมเกมไว ปลอดภัย ติดตามได้ทุกขั้น</span>
        </h1>
        <p className="hero__lead">
          เลือกสินค้า กรอก Game UID แล้วชำระเงิน ระบบจะเติมให้อัตโนมัติและแจ้งสถานะทุกขั้นตอน
        </p>
      </div>
      <div className="hero__art" aria-hidden="true">
        <span className="hero__orb hero__orb--1" />
        <span className="hero__orb hero__orb--2" />
        <svg className="hero__pad" viewBox="0 0 120 80" width="160" height="107">
          <rect x="6" y="14" width="108" height="56" rx="28" fill="#fff" />
          <rect x="26" y="34" width="20" height="6" rx="3" fill="#c8102e" />
          <rect x="33" y="27" width="6" height="20" rx="3" fill="#c8102e" />
          <circle cx="82" cy="32" r="5" fill="#16161a" />
          <circle cx="94" cy="42" r="5" fill="#c8102e" />
          <circle cx="70" cy="42" r="5" fill="#c8102e" />
          <circle cx="82" cy="52" r="5" fill="#16161a" />
        </svg>
      </div>
    </section>
  );
}
