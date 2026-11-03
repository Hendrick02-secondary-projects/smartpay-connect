import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-face", display: "swap" });

export const metadata: Metadata = {
  title: { default: "SmartPay Connect", template: "%s · SmartPay Connect" },
  description: "Plataforma B2B de gestão e reconciliação de pagamentos digitais — demonstração com pagamentos simulados.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#2f4bd0",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="min-h-dvh font-sans">{children}</body>
    </html>
  );
}
