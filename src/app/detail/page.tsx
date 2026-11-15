'use client';

import { Suspense } from 'react';
import { MovieDetailPage } from '@/components/movie-detail-page';

export default function DetailRoute() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-[#08080A]" />}>
      <MovieDetailPage />
    </Suspense>
  );
}
