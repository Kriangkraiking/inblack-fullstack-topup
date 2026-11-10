import type { ReactNode } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/brand";
import { HeaderMenu } from "./header-menu";

/** Customer area chrome: full-width red header, logo in the middle. */
export default function ShopLayout({ children }: { children: ReactNode }) {
  return (
    <div className="shop">
      <header className="site-header">
        <div className="container site-header__bar">
          <div className="site-header__start">
            <HeaderMenu />
          </div>
          <Link className="brand" href="/" aria-label="InBlack Top-Up หน้าแรก">
            <BrandMark />
            <span className="brand__text">
              InBlack <span className="brand__sub">Top-Up</span>
            </span>
          </Link>
          <div className="site-header__end">
            <span className="header-chip" title="ภาษาไทย · เงินบาท">
              TH · ฿
            </span>
            <Link className="header-signin" href="/my-orders">
              เข้าสู่ระบบ
            </Link>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <div className="container">{children}</div>
      </main>
      <footer className="site-footer">
        <div className="container row spread">
          <span>ราคารวม VAT 7% แล้ว · ระบบทดสอบ ไม่มีการตัดเงินจริง</span>
          <nav aria-label="ลิงก์ท้ายหน้า">
            <ul className="footer-links">
              <li>
                <Link href="/track">ติดตามออเดอร์</Link>
              </li>
              <li>
                <Link href="/my-orders">ออเดอร์ของฉัน</Link>
              </li>
            </ul>
          </nav>
        </div>
      </footer>
    </div>
  );
}
