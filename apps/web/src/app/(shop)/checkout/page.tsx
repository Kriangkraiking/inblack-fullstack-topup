import type { Metadata } from "next";
import { fetchProductsOnServer } from "@/lib/server-api";
import { CheckoutForm } from "./checkout-form";

export const metadata: Metadata = {
  title: "สั่งซื้อ",
  alternates: { canonical: "/checkout" },
};

export default async function CheckoutPage({ searchParams }: PageProps<"/checkout">) {
  const params = await searchParams;
  const sku = typeof params.sku === "string" ? params.sku : null;
  const products = await fetchProductsOnServer();
  return (
    <div className="stack">
      <h1>สั่งซื้อ</h1>
      <CheckoutForm initialProducts={products} preselectedSku={sku} />
    </div>
  );
}
