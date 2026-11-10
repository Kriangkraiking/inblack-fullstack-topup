import type { Metadata } from "next";
import Link from "next/link";
import { AdminOrderDetail } from "./admin-order-detail";

export const metadata: Metadata = { title: "รายละเอียดออเดอร์" };

export default async function AdminOrderPage({ params }: PageProps<"/admin/orders/[id]">) {
  const { id } = await params;
  return (
    <>
      <p>
        <Link href="/admin">กลับไปตารางออเดอร์</Link>
      </p>
      <h1>ออเดอร์ {id}</h1>
      <AdminOrderDetail orderId={id} />
    </>
  );
}
