import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { AuthProvider } from "./auth-context";
import { Nav } from "./nav";

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
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
