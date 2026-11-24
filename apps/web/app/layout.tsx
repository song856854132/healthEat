import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";
import { AuthProvider } from "./auth-context";
import { Nav } from "./nav";
import { PrivacyBanner } from "./privacy-banner";

export const metadata: Metadata = {
  title: "healthEat",
  description:
    "A weekly nutrient-and-sensitivity coach. Calorie trackers stop at calories; this does not.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <Nav />
          <PrivacyBanner />
          {children}
          {/* Design doc, "Privacy policy on first visit": /privacy is linked in the footer of every page. */}
          <footer className="site-footer">
            <nav aria-label="Footer" className="site-footer-inner">
              <Link href="/privacy">Privacy policy</Link>
              <Link href="/about">About</Link>
            </nav>
          </footer>
        </AuthProvider>
      </body>
    </html>
  );
}
