import type { Metadata } from "next";
import { AdminShell } from "./admin-shell";

export const metadata: Metadata = {
  title: { default: "ผู้ดูแลระบบ", template: "%s | Admin InBlack" },
  robots: { index: false, follow: false },
};

/**
 * Admin area has its own chrome (sidebar + top bar) and none of the customer
 * header: it sits outside the (shop) route group. The shell is a Client
 * Component because it checks the session cookie through the API.
 */
export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return <AdminShell>{children}</AdminShell>;
}
