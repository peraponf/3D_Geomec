import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "3D Geomec",
  description: "3D Geomechanics Stress/Strain Modeling",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
