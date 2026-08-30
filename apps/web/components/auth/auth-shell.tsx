import Link from 'next/link';

import { Card } from '@/components/ui/card';

export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-100 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-6">
          <div>
            <Link
              href="/"
              className="text-2xl font-semibold text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green"
            >
              Irie Fishmongers
            </Link>
            <p className="mt-1 text-sm text-gray-500">
              Fresh seafood from Jamaica&apos;s waters to your table.
            </p>
          </div>

          <Link
            href="/"
            className="text-sm font-medium text-irie-green hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green"
          >
            Back to marketplace
          </Link>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl justify-center px-4 py-12">
        <Card className="w-full max-w-md">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
            <p className="mt-2 text-sm leading-6 text-gray-500">{description}</p>
          </div>

          {children}

          {footer ? (
            <div className="mt-6 border-t border-gray-100 pt-6 text-center text-sm text-gray-600">
              {footer}
            </div>
          ) : null}
        </Card>
      </main>
    </div>
  );
}
