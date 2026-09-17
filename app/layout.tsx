import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { QUESTION_COUNT } from "@/agent/lib/questions";
import "./globals.css";

const sans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
});

const mono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
});

const title = "Clean Code Judge";
const description = `Paste a PR diff, a codebase, or a GitHub pull request. Jev, TypeSafe’s System One model, answers ${QUESTION_COUNT} Clean Code questions per file in one eve turn, and Luna writes the review.`;

export const metadata: Metadata = {
  title,
  description,
  openGraph: { title, description, type: "website" },
  twitter: { card: "summary_large_image", title, description },
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html className={`${sans.variable} ${mono.variable}`} lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
