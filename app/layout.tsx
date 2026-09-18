import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Daily Joe Careers",
  description: "A thoughtful workspace for the people behind Daily Joe.",
  icons: { icon: "/favicon.svg" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
