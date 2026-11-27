'use client';

import type { AdminCataloguePhotoItem } from '@iriefishmongers/types';
import { ImageOff } from 'lucide-react';
import { useEffect, useState } from 'react';

import { fetchProtectedCataloguePhotoBlob } from '@/lib/api/catalogue-photos';

export function ProtectedPhotoThumbnail({
  photo,
  className = 'h-14 w-20 rounded-md object-cover bg-gray-100',
}: {
  photo: Pick<AdminCataloguePhotoItem, 'id' | 'title' | 'imageUrl' | 'storageProvider' | 'lifecycleStatus'>;
  className?: string;
}): React.ReactElement {
  const isRemoteHttp =
    photo.imageUrl.startsWith('http://') || photo.imageUrl.startsWith('https://');
  const shouldFetchProtected =
    photo.lifecycleStatus === 'DRAFT' ||
    photo.lifecycleStatus === 'REJECTED' ||
    !isRemoteHttp ||
    photo.imageUrl.includes('/admin/catalogue-photos/');

  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!shouldFetchProtected) {
      setBlobSrc(null);
      setFailed(false);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setFailed(false);

    void fetchProtectedCataloguePhotoBlob(photo.id)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [photo.id, photo.imageUrl, shouldFetchProtected]);

  const resolvedSrc = shouldFetchProtected ? blobSrc : photo.imageUrl;

  if (failed || !resolvedSrc) {
    return (
      <div
        className={`flex items-center justify-center bg-gray-100 text-gray-400 ${className}`}
        aria-label={photo.title}
      >
        <ImageOff className="h-4 w-4" aria-hidden="true" />
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={resolvedSrc} alt={photo.title} className={className} />
  );
}
