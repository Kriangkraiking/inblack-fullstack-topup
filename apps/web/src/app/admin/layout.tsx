import type { Metadata } from "next";

export const metadata: Metadata = {
  title: { default: "ผู้ดูแลระบบ", template: "%s | Admin InBlack" },
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return <div className="stack">{children}</div>;
}
