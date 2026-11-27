'use client';

import type { CataloguePhotoOption } from '@iriefishmongers/types';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchPublicPhotoCredits } from '@/lib/api/vendors';
import { DEMO_SAMPLE_PHOTO_CREDITS_LIST, type DemoSamplePhotoCredit } from '@/lib/format';

interface CreditCardRowProps {
  title: string;
  subtitle?: string;
  badgeText: string;
  badgeVariant: 'neutral' | 'warning';
  imageUrl: string;
  author: string;
  sourceLabel: string;
  sourceUrl: string;
  licenseName: string;
  licenseUrl: string;
  modifications: string;
  aliases?: string[];
}

function CreditCardRow({
  title,
  subtitle,
  badgeText,
  badgeVariant,
  imageUrl,
  author,
  sourceLabel,
  sourceUrl,
  licenseName,
  licenseUrl,
  modifications,
  aliases,
}: CreditCardRowProps): React.ReactElement {
  return (
    <Card className="overflow-hidden">
      <div className="grid gap-4 p-4 sm:grid-cols-[140px_1fr]">
        <div className="relative h-28 w-full overflow-hidden rounded-lg bg-gray-100 sm:h-28 sm:w-36">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt={title} className="h-full w-full object-cover" />
        </div>
        <div className="min-w-0 space-y-1.5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-gray-900">{title}</h3>
            <Badge variant={badgeVariant}>{badgeText}</Badge>
          </div>
          {subtitle ? <p className="text-xs italic text-gray-600">{subtitle}</p> : null}
          {aliases && aliases.length > 0 ? (
            <p className="text-xs text-gray-600">
              <span className="font-medium text-gray-700">Jamaican market names:</span>{' '}
              {aliases.join(', ')}
            </p>
          ) : null}
          <dl className="grid gap-1 pt-1 text-xs text-gray-600 sm:grid-cols-2">
            <div>
              <dt className="inline font-medium text-gray-800">Photographer / Creator: </dt>
              <dd className="inline">{author}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-gray-800">Licence: </dt>
              <dd className="inline">
                <a
                  href={licenseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline hover:text-gray-900"
                >
                  {licenseName}
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="inline font-medium text-gray-800">Source: </dt>
              <dd className="inline break-words">
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline hover:text-gray-900"
                >
                  {sourceLabel}
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="inline font-medium text-gray-800">Modifications: </dt>
              <dd className="inline">{modifications}</dd>
            </div>
          </dl>
        </div>
      </div>
    </Card>
  );
}

function mapCataloguePhotoToRow(photo: CataloguePhotoOption): CreditCardRowProps {
  const badgeText = photo.retiredAt
    ? 'Archived reference (in use)'
    : photo.isDefault
      ? 'Catalogue reference photo · Default'
      : 'Catalogue reference photo';
  return {
    title: photo.title,
    subtitle: photo.scientificName,
    badgeText,
    badgeVariant: photo.retiredAt ? 'warning' : 'neutral',
    imageUrl: photo.imageUrl,
    author: photo.photographer,
    sourceLabel: photo.sourceName,
    sourceUrl: photo.sourceUrl,
    licenseName: photo.licenseName,
    licenseUrl: photo.licenseUrl,
    modifications: photo.modifications,
    aliases: photo.jamaicanAliases,
  };
}

function mapDemoCreditToRow(credit: DemoSamplePhotoCredit): CreditCardRowProps {
  return {
    title: credit.title,
    badgeText: 'Sample Photo (Demo)',
    badgeVariant: 'warning',
    imageUrl: credit.assetPath,
    author: credit.author,
    sourceLabel: credit.sourceLabel,
    sourceUrl: credit.sourceUrl,
    licenseName: credit.licenseName,
    licenseUrl: credit.licenseUrl,
    modifications: credit.modifications,
  };
}

export function PhotoCreditsView(): React.ReactElement {
  const photosQuery = useQuery({
    queryKey: ['catalogue', 'photos', 'credits'],
    queryFn: () => fetchPublicPhotoCredits(),
  });

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 space-y-8">
      <div className="space-y-2">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-irie-green hover:underline"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to Marketplace
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">
          Seafood photo credits, sources &amp; licences
        </h1>
        <p className="text-sm text-gray-600 max-w-3xl">
          Every bundled catalogue reference image and staging sample photo carries verified scientific
          species matching, photographer attribution, licence terms, and modification disclosures.
        </p>
      </div>

      <section aria-labelledby="catalogue-credits-heading" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="catalogue-credits-heading" className="text-lg font-semibold text-gray-900">
            Catalogue reference photo library
          </h2>
          <a
            href="/catalogue-photos/SOURCES.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-irie-green underline hover:text-irie-green/80"
          >
            Download / view raw catalogue SOURCES.md
          </a>
        </div>

        {photosQuery.isPending ? (
          <Card>
            <CardContent className="p-6 text-sm text-gray-500">
              Loading verified catalogue photo library credits…
            </CardContent>
          </Card>
        ) : photosQuery.isError ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Catalogue library metadata unavailable</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-gray-600">
              Live API photo credits could not be reached right now; you can inspect the bundled
              manifest directly via{' '}
              <a
                href="/catalogue-photos/SOURCES.md"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                /catalogue-photos/SOURCES.md
              </a>
              .
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4" data-testid="catalogue-credits-list">
            {photosQuery.data.map((photo) => (
              <CreditCardRow key={photo.id} {...mapCataloguePhotoToRow(photo)} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="demo-credits-heading" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="demo-credits-heading" className="text-lg font-semibold text-gray-900">
            Staging demo sample photos
          </h2>
          <a
            href="/demo-products/SOURCES.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-irie-green underline hover:text-irie-green/80"
          >
            Download / view raw demo SOURCES.md
          </a>
        </div>
        <div className="space-y-4" data-testid="demo-credits-list">
          {DEMO_SAMPLE_PHOTO_CREDITS_LIST.map((credit) => (
            <CreditCardRow key={credit.assetPath} {...mapDemoCreditToRow(credit)} />
          ))}
        </div>
      </section>
    </main>
  );
}
