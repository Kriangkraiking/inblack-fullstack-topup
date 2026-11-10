import type { Metadata } from "next";
import { TrackClient } from "./track-client";

export const metadata: Metadata = {
  title: "ติดตามออเดอร์",
  robots: { index: false, follow: false },
};

export default async function TrackPage({ searchParams }: PageProps<"/track">) {
  const params = await searchParams;
  const orderId = typeof params.order_id === "string" ? params.order_id : "";
  const paymentResult = typeof params.payment_result === "string" ? params.payment_result : null;
  return (
    <div className="stack">
      <h1>ติดตามออเดอร์</h1>
      <TrackClient initialOrderId={orderId} paymentResult={paymentResult} />
    </div>
  );
}
