'use client';

import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';

export interface CropTransformSettings {
  focusX: number; // 0..100
  focusY: number; // 0..100
  zoom: number; // 1..2.5
  applyCrop: boolean;
}

export async function renderCroppedStorefrontFile(
  sourceFile: File,
  transform: CropTransformSettings,
): Promise<{ file: File; description: string }> {
  if (!transform.applyCrop || typeof document === 'undefined') {
    return {
      file: sourceFile,
      description: 'Original aspect ratio preserved',
    };
  }

  const targetWidth = 900;
  const targetHeight = 600;
  const objectUrl = URL.createObjectURL(sourceFile);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Unable to decode selected image for crop preview'));
      el.src = objectUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { file: sourceFile, description: 'Original framing' };
    }

    const imgRatio = img.naturalWidth / Math.max(1, img.naturalHeight);
    const targetRatio = targetWidth / targetHeight;

    let baseCropWidth = img.naturalWidth;
    let baseCropHeight = img.naturalHeight;
    if (imgRatio > targetRatio) {
      baseCropWidth = img.naturalHeight * targetRatio;
    } else {
      baseCropHeight = img.naturalWidth / targetRatio;
    }

    const cropWidth = baseCropWidth / Math.max(1, transform.zoom);
    const cropHeight = baseCropHeight / Math.max(1, transform.zoom);
    const maxOffsetX = Math.max(0, img.naturalWidth - cropWidth);
    const maxOffsetY = Math.max(0, img.naturalHeight - cropHeight);
    const sx = (transform.focusX / 100) * maxOffsetX;
    const sy = (transform.focusY / 100) * maxOffsetY;

    ctx.drawImage(img, sx, sy, cropWidth, cropHeight, 0, 0, targetWidth, targetHeight);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), 'image/png'),
    );
    if (!blob) {
      return { file: sourceFile, description: 'Original framing' };
    }

    const baseName = sourceFile.name.replace(/\.[^.]+$/, '') || 'catalogue-photo';
    const croppedFile = new File([blob], `${baseName}-900x600.png`, { type: 'image/png' });
    return {
      file: croppedFile,
      description: `Cropped/resized to ${targetWidth}x${targetHeight} PNG (focus ${transform.focusX}%x/${transform.focusY}%y, ${transform.zoom.toFixed(1)}x zoom)`,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function StorefrontCropPreview({
  file,
  title,
  value,
  onChange,
}: {
  file: File | null;
  title: string;
  value: CropTransformSettings;
  onChange: (next: CropTransformSettings) => void;
}): React.ReactElement | null {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      setNaturalSize(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  if (!file || !previewUrl) {
    return null;
  }

  const imageStyle: React.CSSProperties = {
    objectPosition: `${value.focusX}% ${value.focusY}%`,
    transform: `scale(${value.zoom})`,
    transformOrigin: `${value.focusX}% ${value.focusY}%`,
  };

  return (
    <div
      className="space-y-3 rounded-card border border-gray-200 bg-gray-50 p-4"
      data-testid="storefront-crop-preview"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Storefront Crop Preview</h3>
          <p className="text-xs text-gray-500">
            Preview how this photo frames on storefront cards (1:1) and vendor pickers (3:2) before submitting.
            {naturalSize ? ` Source: ${naturalSize.w}×${naturalSize.h}px.` : ''}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs font-medium text-gray-700">
          <input
            type="checkbox"
            checked={value.applyCrop}
            onChange={(e) => onChange({ ...value, applyCrop: e.target.checked })}
            className="h-4 w-4 rounded border-gray-300 text-irie-green focus:ring-irie-green"
          />
          Export 900×600 PNG crop on upload
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-gray-700">Storefront Card (1:1 square crop)</p>
          <div className="relative aspect-square w-full max-w-[220px] overflow-hidden rounded-lg border border-gray-200 bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt={`${title || 'Preview'} 1:1 crop`}
              style={imageStyle}
              onLoad={(e) =>
                setNaturalSize({
                  w: e.currentTarget.naturalWidth,
                  h: e.currentTarget.naturalHeight,
                })
              }
              className="h-full w-full object-cover transition-transform"
            />
            <Badge className="absolute left-2 top-2 bg-gray-900/80 text-white">
              Catalogue reference photo
            </Badge>
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-gray-700">Vendor Picker Card (3:2 landscape crop)</p>
          <div className="relative aspect-[3/2] w-full max-w-[300px] overflow-hidden rounded-lg border border-gray-200 bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt={`${title || 'Preview'} 3:2 crop`}
              style={imageStyle}
              className="h-full w-full object-cover transition-transform"
            />
            <Badge className="absolute left-2 top-2 bg-gray-900/80 text-white">
              Catalogue reference photo
            </Badge>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-gray-700">
          Horizontal focus ({value.focusX}%)
          <input
            type="range"
            min={0}
            max={100}
            value={value.focusX}
            onChange={(e) => onChange({ ...value, focusX: Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-700">
          Vertical focus ({value.focusY}%)
          <input
            type="range"
            min={0}
            max={100}
            value={value.focusY}
            onChange={(e) => onChange({ ...value, focusY: Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-700">
          Zoom ({value.zoom.toFixed(1)}×)
          <input
            type="range"
            min={1}
            max={2.5}
            step={0.1}
            value={value.zoom}
            onChange={(e) => onChange({ ...value, zoom: Number(e.target.value) })}
          />
        </label>
      </div>
    </div>
  );
}
