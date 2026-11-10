import type { Metadata } from "next";
import { MyOrdersClient } from "./my-orders-client";

export const metadata: Metadata = {
  title: "ออเดอร์ของฉัน",
  robots: { index: false, follow: false },
};

export default function MyOrdersPage() {
  return (
    <div className="stack narrow">
      <h1 className="page-title">ออเดอร์ของฉัน</h1>
      <MyOrdersClient />
    </div>
  );
}
