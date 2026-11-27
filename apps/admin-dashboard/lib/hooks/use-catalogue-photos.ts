import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  approveCataloguePhoto,
  bulkSwitchCatalogueListings,
  fetchAdminCataloguePhotoHistory,
  fetchAdminCataloguePhotos,
  rejectCataloguePhoto,
  replaceCataloguePhotoVersion,
  restoreCataloguePhoto,
  retireCataloguePhoto,
  setDefaultCataloguePhoto,
  updateCataloguePhotoMetadata,
  uploadCataloguePhotoDraft,
  type ListAdminCataloguePhotosParams,
} from '@/lib/api/catalogue-photos';

export function useAdminCataloguePhotos(params?: ListAdminCataloguePhotosParams) {
  return useQuery({
    queryKey: ['admin', 'catalogue-photos', params ?? {}],
    queryFn: () => fetchAdminCataloguePhotos(params),
  });
}

export function useAdminCataloguePhotoHistory(id: string | null) {
  return useQuery({
    queryKey: ['admin', 'catalogue-photo-history', id],
    queryFn: () => fetchAdminCataloguePhotoHistory(id!),
    enabled: Boolean(id),
  });
}

export function useCataloguePhotoMutations() {
  const queryClient = useQueryClient();

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'catalogue-photos'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'catalogue-photo-history'] });
  }

  return {
    uploadDraft: useMutation({
      mutationFn: uploadCataloguePhotoDraft,
      onSuccess: invalidate,
    }),
    updateMetadata: useMutation({
      mutationFn: ({ id, formData }: { id: string; formData: FormData }) =>
        updateCataloguePhotoMetadata(id, formData),
      onSuccess: invalidate,
    }),
    replaceVersion: useMutation({
      mutationFn: ({ id, formData }: { id: string; formData: FormData }) =>
        replaceCataloguePhotoVersion(id, formData),
      onSuccess: invalidate,
    }),
    approve: useMutation({
      mutationFn: ({ id, setAsDefault }: { id: string; setAsDefault?: boolean }) =>
        approveCataloguePhoto(id, setAsDefault),
      onSuccess: invalidate,
    }),
    reject: useMutation({
      mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
        rejectCataloguePhoto(id, reason),
      onSuccess: invalidate,
    }),
    setDefault: useMutation({
      mutationFn: (id: string) => setDefaultCataloguePhoto(id),
      onSuccess: invalidate,
    }),
    retire: useMutation({
      mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
        retireCataloguePhoto(id, reason),
      onSuccess: invalidate,
    }),
    restore: useMutation({
      mutationFn: (id: string) => restoreCataloguePhoto(id),
      onSuccess: invalidate,
    }),
    bulkSwitch: useMutation({
      mutationFn: ({
        toPhotoId,
        fromPhotoId,
        productIds,
      }: {
        toPhotoId: string;
        fromPhotoId: string;
        productIds?: string[];
      }) => bulkSwitchCatalogueListings(toPhotoId, fromPhotoId, productIds),
      onSuccess: invalidate,
    }),
  };
}
