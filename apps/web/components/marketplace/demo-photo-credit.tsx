'use client';

import type { CataloguePhotoOption } from '@iriefishmongers/types';
import Link from 'next/link';

import {
  DEMO_SHRIMP_SAMPLE_CREDIT,
  getDemoSamplePhotoCredit,
  type DemoSamplePhotoCredit,
} from '@/lib/format';

interface NormalizedPhotoCredit {
  kindLabel: string;
  title: string;
  author: string;
  sourceLabel: string;
  sourceUrl: string;
  licenseName: string;
  licenseUrl: string;
  modifications: string;
}

function normalizePhotoCredit(
  imageUrl: string | null | undefined,
  catalogueCredit: CataloguePhotoOption | null | undefined,
): NormalizedPhotoCredit | null {
  if (catalogueCredit) {
    return {
      kindLabel: 'catalogue reference photo',
      title: catalogueCredit.title,
      author: catalogueCredit.photographer,
      sourceLabel: catalogueCredit.sourceName,
      sourceUrl: catalogueCredit.sourceUrl,
      licenseName: catalogueCredit.licenseName,
      licenseUrl: catalogueCredit.licenseUrl,
      modifications: catalogueCredit.modifications,
    };
  }

  const demoCredit = getDemoSamplePhotoCredit(imageUrl);
  if (!demoCredit) {
    return null;
  }

  return {
    kindLabel: 'sample photo',
    title: demoCredit.title,
    author: demoCredit.author,
    sourceLabel: demoCredit.sourceLabel,
    sourceUrl: demoCredit.sourceUrl,
    licenseName: demoCredit.licenseName,
    licenseUrl: demoCredit.licenseUrl,
    modifications: demoCredit.modifications,
  };
}

function CreditDetails({ credit }: { credit: NormalizedPhotoCredit }): React.ReactElement {
  return (
    <>
      <span>
        {credit.title} {credit.kindLabel}:{' '}
      </span>
      <a
        href={credit.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-gray-700"
      >
        {credit.sourceLabel}
      </a>
      <span> by {credit.author} (</span>
      <a
        href={credit.licenseUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-gray-700"
      >
        {credit.licenseName}
      </a>
      <span>). Modified: {credit.modifications}.</span>
    </>
  );
}

/**
 * Renders licensing, author attribution, and modification notes for bundled
 * `/demo-products/*` sample assets or catalogue library reference photos,
 * plus links to `/photo-credits`.
 */
export function DemoPhotoCreditLine({
  imageUrl,
  catalogueCredit,
  className = '',
}: {
  imageUrl: string | null | undefined;
  catalogueCredit?: CataloguePhotoOption | null;
  className?: string;
}): React.ReactElement | null {
  const credit = normalizePhotoCredit(imageUrl, catalogueCredit);
  if (!credit) {
    return null;
  }

  return (
    <p
      className={`text-xs text-gray-500 leading-relaxed ${className}`.trim()}
      data-testid="demo-photo-credit-line"
    >
      <CreditDetails credit={credit} />{' '}
      <Link href="/photo-credits" className="underline hover:text-gray-700">
        Photo credits &amp; licences
      </Link>
      .
    </p>
  );
}

function demoCreditToNormalized(credit: DemoSamplePhotoCredit): NormalizedPhotoCredit {
  return {
    kindLabel: 'sample photo',
    title: credit.title,
    author: credit.author,
    sourceLabel: credit.sourceLabel,
    sourceUrl: credit.sourceUrl,
    licenseName: credit.licenseName,
    licenseUrl: credit.licenseUrl,
    modifications: credit.modifications,
  };
}

/**
 * Footer notice on the storefront surfacing attribution and modification
 * notices for demo and catalogue library imagery alongside `/photo-credits`
 * and raw `SOURCES.md` manifests.
 */
export function StorefrontPhotoCreditsNotice(): React.ReactElement {
  return (
    <footer
      className="border-t border-gray-200 pt-4 text-xs text-gray-500 leading-relaxed"
      data-testid="storefront-photo-credits"
    >
      <span>Demo imagery credits: </span>
      <CreditDetails credit={demoCreditToNormalized(DEMO_SHRIMP_SAMPLE_CREDIT)} />{' '}
      <Link href="/photo-credits" className="font-medium underline hover:text-gray-700">
        View all photo credits &amp; licences
      </Link>{' '}
      ·{' '}
      <a
        href="/catalogue-photos/SOURCES.md"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-gray-700"
      >
        Catalogue sources
      </a>{' '}
      ·{' '}
      <a
        href="/demo-products/SOURCES.md"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-gray-700"
      >
        Demo sources
      </a>
      .
    </footer>
  );
}
