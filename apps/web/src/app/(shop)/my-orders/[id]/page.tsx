import type { Metadata } from "next";
import Link from "next/link";
import { OrderDetailClient } from "./order-detail-client";

export const metadata: Metadata = {
  title: "รายละเอียดออเดอร์",
  robots: { index: false, follow: false },
};

export default async function MyOrderDetailPage({ params }: PageProps<"/my-orders/[id]">) {
  const { id } = await params;
  return (
    <div className="stack">
      <p>
        <Link href="/my-orders">กลับไปออเดอร์ของฉัน</Link>
      </p>
      <h1>รายละเอียดออเดอร์</h1>
      <OrderDetailClient orderId={id} />
    </div>
  );
}
