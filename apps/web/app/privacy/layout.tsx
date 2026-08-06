import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | PROTOCOL-01",
  description:
    "Privacy Policy for Protocol 01, how we handle your data with zero-knowledge principles.",
};

export default function PrivacyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
