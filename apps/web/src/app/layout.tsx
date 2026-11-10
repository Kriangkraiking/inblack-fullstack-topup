import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? "http://localhost:3000"),
  title: { default: "InBlack Top-Up เติมเกม", template: "%s | InBlack Top-Up" },
  description: "เติมเพชร Monthly Pass และสกินลิมิเต็ดของเกม ชำระด้วยพร้อมเพย์ TrueMoney หรือบัตร ติดตามสถานะได้สด",
};

/**
 * Root layout: only <html>/<body>. The customer chrome (red header, footer)
 * lives in app/(shop)/layout.tsx and the admin chrome in app/admin/layout.tsx,
 * so the two areas never share a header. "(shop)" is a route group: the
 * folder name does not appear in the URL.
 */
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
        {children}
      </body>
    </html>
  );
}
