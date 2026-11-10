import type { Metadata } from "next";
import { AdminHome } from "./admin-home";

export const metadata: Metadata = { title: "ออเดอร์" };

export default function AdminPage() {
  return (
    <>
      <h1>ผู้ดูแลระบบ: ออเดอร์</h1>
      <AdminHome />
    </>
  );
}
