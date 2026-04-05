import type { Metadata } from "next";
import { Instrument_Serif, Manrope } from "next/font/google";

import "./globals.css";

import { AppShell } from "@/components/app-shell";

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument",
  subsets: ["latin"],
  weight: "400",
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Citation Fidelity UI",
  description: "Local orchestration and artifact inspection for citation-fidelity.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      className={`${instrumentSerif.variable} ${manrope.variable}`}
      lang="en"
    >
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
