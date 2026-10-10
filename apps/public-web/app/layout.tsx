import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Cave | PlayStation Salonu", description: "Oyun, rekabet ve keyif için Cave PlayStation Salonu." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="tr"><body>{children}</body></html>; }
