import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Not found</h1>
        <p className="mt-2 text-sm text-zinc-500">That page or post doesn&apos;t exist.</p>
        <Link href="/" className="btn-primary mt-6">Back to dashboard</Link>
      </div>
    </main>
  );
}
