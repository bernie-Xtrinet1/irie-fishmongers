import { randomUUID } from 'crypto';

import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface StoredBlobResult {
  storageContainer: string;
  storageKey: string;
  publicUrl?: string;
}

export function slugifySpeciesKey(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'seafood';
}

@Injectable()
export class CataloguePhotoStorageService {
  private readonly logger = new Logger(CataloguePhotoStorageService.name);
  private client: BlobServiceClient | null = null;
  private initializedContainers = new Set<string>();

  constructor(private readonly configService: ConfigService) {}

  get publicContainerName(): string {
    return this.configService.get<string>('AZURE_STORAGE_PUBLIC_CONTAINER')?.trim() || 'catalogue-photos';
  }

  get privateContainerName(): string {
    return (
      this.configService.get<string>('AZURE_STORAGE_PRIVATE_CONTAINER')?.trim() ||
      'catalogue-photos-drafts'
    );
  }

  get accountName(): string | undefined {
    return this.configService.get<string>('AZURE_STORAGE_ACCOUNT_NAME')?.trim() || undefined;
  }

  get connectionString(): string | undefined {
    return this.configService.get<string>('AZURE_STORAGE_CONNECTION_STRING')?.trim() || undefined;
  }

  get publicBaseUrlOverride(): string | undefined {
    const raw = this.configService.get<string>('AZURE_STORAGE_PUBLIC_BASE_URL')?.trim();
    return raw ? raw.replace(/\/+$/, '') : undefined;
  }

  isConfigured(): boolean {
    return Boolean(this.connectionString || this.accountName);
  }

  private getBlobServiceClient(): BlobServiceClient {
    if (this.client) {
      return this.client;
    }

    if (this.connectionString) {
      this.client = BlobServiceClient.fromConnectionString(this.connectionString);
      return this.client;
    }

    if (this.accountName) {
      const accountUrl = `https://${this.accountName}.blob.core.windows.net`;
      const clientId = this.configService.get<string>('AZURE_STORAGE_CLIENT_ID')?.trim() || undefined;
      const credential = new DefaultAzureCredential(
        clientId ? { managedIdentityClientId: clientId } : undefined,
      );
      this.client = new BlobServiceClient(accountUrl, credential);
      return this.client;
    }

    throw new ServiceUnavailableException(
      'Azure Blob Storage is not configured. Set AZURE_STORAGE_ACCOUNT_NAME or AZURE_STORAGE_CONNECTION_STRING before uploading catalogue photos.',
    );
  }

  private async getContainerClient(
    containerName: string,
    isPublic: boolean,
  ): Promise<ContainerClient> {
    const service = this.getBlobServiceClient();
    const container = service.getContainerClient(containerName);
    if (!this.initializedContainers.has(containerName)) {
      try {
        const exists = await container.exists();
        if (!exists) {
          await container.create(isPublic ? { access: 'blob' } : undefined);
        }
      } catch (err) {
        // When using data-plane RBAC in Azure where containers are pre-provisioned by Bicep,
        // container.exists() succeeds; if create fails due to already existing, proceed safely.
        this.logger.warn(
          `Container check/create warning for "${containerName}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      this.initializedContainers.add(containerName);
    }
    return container;
  }

  buildPublicUrl(storageContainer: string, storageKey: string): string {
    const cleanKey = storageKey.replace(/^\/+/, '');
    if (this.publicBaseUrlOverride) {
      return `${this.publicBaseUrlOverride}/${cleanKey}`;
    }
    const container = this.getBlobServiceClient().getContainerClient(storageContainer);
    return container.getBlockBlobClient(cleanKey).url;
  }

  async uploadPrivateDraft(params: {
    speciesName: string;
    photoId: string;
    versionNumber: number;
    extension: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<StoredBlobResult> {
    const containerName = this.privateContainerName;
    const container = await this.getContainerClient(containerName, false);
    const speciesSlug = slugifySpeciesKey(params.speciesName);
    const storageKey = `drafts/${speciesSlug}/${params.photoId}/v${params.versionNumber}-${randomUUID()}.${params.extension}`;

    const blobClient = container.getBlockBlobClient(storageKey);
    await blobClient.uploadData(params.buffer, {
      blobHTTPHeaders: {
        blobContentType: params.mimeType,
        blobCacheControl: 'private, no-store',
      },
    });

    return {
      storageContainer: containerName,
      storageKey,
    };
  }

  async uploadPublishedVersion(params: {
    speciesName: string;
    versionGroupId: string;
    versionNumber: number;
    extension: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<StoredBlobResult & { publicUrl: string }> {
    const containerName = this.publicContainerName;
    const container = await this.getContainerClient(containerName, true);
    const speciesSlug = slugifySpeciesKey(params.speciesName);
    const storageKey = `published/${speciesSlug}/${params.versionGroupId}/v${params.versionNumber}-${randomUUID()}.${params.extension}`;

    const blobClient = container.getBlockBlobClient(storageKey);
    await blobClient.uploadData(params.buffer, {
      blobHTTPHeaders: {
        blobContentType: params.mimeType,
        blobCacheControl: 'public, max-age=31536000, immutable',
      },
    });

    return {
      storageContainer: containerName,
      storageKey,
      publicUrl: this.buildPublicUrl(containerName, storageKey),
    };
  }

  async promotePrivateDraftToPublic(params: {
    privateContainer: string;
    privateStorageKey: string;
    speciesName: string;
    versionGroupId: string;
    versionNumber: number;
    mimeType: string;
  }): Promise<StoredBlobResult & { publicUrl: string }> {
    const buffer = await this.downloadBlobBuffer(params.privateContainer, params.privateStorageKey);
    const ext = params.privateStorageKey.split('.').pop() || 'png';
    return this.uploadPublishedVersion({
      speciesName: params.speciesName,
      versionGroupId: params.versionGroupId,
      versionNumber: params.versionNumber,
      extension: ext,
      mimeType: params.mimeType,
      buffer,
    });
  }

  async downloadBlobBuffer(containerName: string, storageKey: string): Promise<Buffer> {
    const container = this.getBlobServiceClient().getContainerClient(containerName);
    const blobClient = container.getBlockBlobClient(storageKey);
    try {
      return await blobClient.downloadToBuffer();
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404) {
        throw new NotFoundException('Catalogue photo object was not found in storage');
      }
      throw err;
    }
  }
}
