import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { LayoutProvider } from "./layoutProvider";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "CAIT – Claw Artificial Intelligent Trader",
  description:
    "AI-powered CKB trading agent with Martingale strategy. Built for the Claw & Order Hackathon on CKB Testnet.",
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn("dark", "font-sans", geist.variable)}>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#0d0d1a]`}
      >
        <LayoutProvider>{children}</LayoutProvider>
      </body>
    </html>
  );
}
