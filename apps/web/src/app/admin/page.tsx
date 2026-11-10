import type { Metadata } from "next";
import { AdminHome } from "./admin-home";

export const metadata: Metadata = { title: "แดชบอร์ดออเดอร์" };

export default function AdminPage() {
  return <AdminHome />;
}
