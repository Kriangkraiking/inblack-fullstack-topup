import type { Metadata } from "next";
import { MyOrdersClient } from "./my-orders-client";

export const metadata: Metadata = {
  title: "ออเดอร์ของฉัน",
  robots: { index: false, follow: false },
};

export default function MyOrdersPage() {
  return (
    <div className="stack">
      <h1>ออเดอร์ของฉัน</h1>
      <MyOrdersClient />
    </div>
  );
}
