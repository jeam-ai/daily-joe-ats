import type { Metadata } from "next";
import "./globals.css";
import "./polish.css";
export const metadata: Metadata = {
  title: "Daily Joe Careers",
  description: "Daily Joe Careers — internal recruitment and HR workspace.",
  applicationName: "Daily Joe Careers",
  robots: { index: false, follow: false },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: "/apple-touch-icon.png",
  },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try { var t = localStorage.getItem("djc-theme"); if (t === "light" || t === "dark" || t === "system") document.documentElement.dataset.theme = t === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : t; } catch {}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
