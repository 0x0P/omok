import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "omok",
  description: "오목",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
