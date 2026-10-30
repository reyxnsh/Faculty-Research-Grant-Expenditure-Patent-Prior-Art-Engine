import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Grant Expenditure & Prior-Art Engine',
  description: 'Faculty Research Grant Expenditure & Patent Prior-Art Engine',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
