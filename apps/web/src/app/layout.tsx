import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? "http://localhost:3000"),
  title: { default: "InBlack Top-Up เติมเกม", template: "%s | InBlack Top-Up" },
  description: "เติมเพชร Monthly Pass และสกินลิมิเต็ดของเกม ชำระด้วยพร้อมเพย์ TrueMoney หรือบัตร ติดตามสถานะได้สด",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Reading the request headers makes every page render per request, which the
  // nonce CSP in src/proxy.ts needs (a page built ahead of time has no nonce).
  await headers();
  return (
    <html lang="th">
      <body>
        <a className="skip-link" href="#main">
          ข้ามไปเนื้อหาหลัก
        </a>
        <header className="site-header">
          <div className="container">
            <Link className="brand" href="/">
              InBlack Top-Up
            </Link>
            <nav className="site-nav" aria-label="เมนูหลัก">
              <ul>
                <li>
                  <Link href="/">สินค้า</Link>
                </li>
                <li>
                  <Link href="/checkout">สั่งซื้อ</Link>
                </li>
                <li>
                  <Link href="/track">ติดตามออเดอร์</Link>
                </li>
                <li>
                  <Link href="/my-orders">ออเดอร์ของฉัน</Link>
                </li>
              </ul>
            </nav>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          <div className="container">{children}</div>
        </main>
        <footer className="site-footer">
          <div className="container">ราคารวม VAT 7% แล้ว · ระบบทดสอบ ไม่มีการตัดเงินจริง</div>
        </footer>
      </body>
    </html>
  );
}
