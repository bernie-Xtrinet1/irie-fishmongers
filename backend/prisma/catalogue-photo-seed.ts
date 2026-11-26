import {
  CatalogueCompositionMode,
  CatalogueLifecycleStatus,
  CataloguePhotoApprovalStatus,
  PrismaClient,
  ProductUnit,
  RegulatoryStatus,
} from '@prisma/client';

export interface SeedSpeciesDefinition {
  scientificName: string;
  commercialName: string;
  regulatoryStatus: RegulatoryStatus;
}

export interface SeedCatalogueItemDefinition {
  speciesScientificName: string;
  name: string;
  commonName: string;
  jamaicanNames: string[];
  categorySlug: 'fish' | 'crustaceans' | 'shellfish' | 'mollusks';
  description: string;
  referenceImageUrl: string;
  imageSourceLicense: string;
  typicalUnit: ProductUnit;
}

export interface SeedCataloguePhotoDefinition {
  speciesScientificName: string;
  catalogueItemName: string;
  title: string;
  scientificName: string;
  jamaicanAliases: string[];
  imageUrl: string;
  sourceName: string;
  sourceUrl: string;
  photographer: string;
  licenseName: string;
  licenseUrl: string;
  modifications: string;
  requiresAttribution: boolean;
  approvalStatus: CataloguePhotoApprovalStatus;
}

// Keep existing seeded species and regulatory statuses intact (Conch remains RESTRICTED),
// and add Tilapia plus commonly sold Jamaican market species (Grouper, Parrotfish, Doctor Fish).
export const SPECIES_DEFINITIONS: SeedSpeciesDefinition[] = [
  { scientificName: 'Lutjanus analis', commercialName: 'Snapper', regulatoryStatus: 'UNRESTRICTED' },
  { scientificName: 'Scomberomorus cavalla', commercialName: 'King Fish', regulatoryStatus: 'UNRESTRICTED' },
  { scientificName: 'Scomber scombrus', commercialName: 'Mackerel', regulatoryStatus: 'UNRESTRICTED' },
  { scientificName: 'Panulirus argus', commercialName: 'Lobster', regulatoryStatus: 'UNRESTRICTED' },
  { scientificName: 'Penaeus spp.', commercialName: 'Shrimp', regulatoryStatus: 'UNRESTRICTED' },
  { scientificName: 'Lobatus gigas', commercialName: 'Conch', regulatoryStatus: 'RESTRICTED' },
  { scientificName: 'Oreochromis niloticus', commercialName: 'Tilapia', regulatoryStatus: 'UNRESTRICTED' },
  { scientificName: 'Epinephelus guttatus', commercialName: 'Grouper', regulatoryStatus: 'UNRESTRICTED' },
  { scientificName: 'Sparisoma viride', commercialName: 'Parrotfish', regulatoryStatus: 'UNRESTRICTED' },
  { scientificName: 'Acanthurus chirurgus', commercialName: 'Doctor Fish', regulatoryStatus: 'UNRESTRICTED' },
];

export const CATALOGUE_ITEM_DEFINITIONS: SeedCatalogueItemDefinition[] = [
  {
    speciesScientificName: 'Lutjanus analis',
    name: 'Red Snapper (Fresh Whole)',
    commonName: 'Red Snapper',
    jamaicanNames: ['Red Snapper', 'Mutton Snapper', 'Snapper', 'Whole Snapper', 'Roast Fish Snapper'],
    categorySlug: 'fish',
    description: 'Whole fresh Mutton/Red Snapper landed by Jamaican inshore and bank fishers.',
    referenceImageUrl: '/catalogue-photos/lutjanus-analis.png',
    imageSourceLicense: 'Public Domain (PD-USGov-NOAA) — NOAA Photo Library',
    typicalUnit: ProductUnit.PER_POUND,
  },
  {
    speciesScientificName: 'Oreochromis niloticus',
    name: 'Tilapia (Fresh Whole)',
    commonName: 'Tilapia',
    jamaicanNames: ['Tilapia', 'Red Belly', 'Pond Fish', 'Nile Tilapia', 'Freshwater Fish'],
    categorySlug: 'fish',
    description: 'Fresh whole farm-raised Jamaican Tilapia, ideal for escovitch or steaming.',
    referenceImageUrl: '/catalogue-photos/oreochromis-niloticus.png',
    imageSourceLicense: 'CC BY-SA 3.0 — Bjørn Christian Tørrissen',
    typicalUnit: ProductUnit.PER_POUND,
  },
  {
    speciesScientificName: 'Scomberomorus cavalla',
    name: 'King Fish (Fresh Catch)',
    commonName: 'King Fish',
    jamaicanNames: ['Kingfish', 'King Fish', 'Cavalla', 'King Mackerel', 'Kingfish Steak'],
    categorySlug: 'fish',
    description: 'Firm-fleshed coastal King Fish prized for steaks and escovitch.',
    referenceImageUrl: '/catalogue-photos/scomberomorus-cavalla.png',
    imageSourceLicense: 'Public Domain (PD-USGov-NOAA) — SEFSC Pascagoula Laboratory',
    typicalUnit: ProductUnit.PER_POUND,
  },
  {
    speciesScientificName: 'Scomber scombrus',
    name: 'Mackerel (Fresh Whole)',
    commonName: 'Mackerel',
    jamaicanNames: ['Mackerel', 'Atlantic Mackerel', 'Tinker Mackerel', 'Salt Mackerel'],
    categorySlug: 'fish',
    description: 'Oil-rich whole mackerel popular across Jamaican markets.',
    referenceImageUrl: '/catalogue-photos/scomber-scombrus.png',
    imageSourceLicense: 'CC0 1.0 — Fumikas Sagisavas',
    typicalUnit: ProductUnit.PER_POUND,
  },
  {
    speciesScientificName: 'Panulirus argus',
    name: 'Caribbean Spiny Lobster',
    commonName: 'Spiny Lobster',
    jamaicanNames: ['Spiny Lobster', 'Caribbean Spiny Lobster', 'Crayfish', 'Lobster'],
    categorySlug: 'crustaceans',
    description: 'Whole Caribbean Spiny Lobster caught cleanly in seasonal traps.',
    referenceImageUrl: '/catalogue-photos/panulirus-argus.png',
    imageSourceLicense: 'Public Domain (PD-USGov-NOAA) — SEFSC Pascagoula Laboratory',
    typicalUnit: ProductUnit.PER_ITEM,
  },
  {
    speciesScientificName: 'Penaeus spp.',
    name: 'Jumbo Shrimp (Whole / Raw)',
    commonName: 'Jumbo Shrimp',
    jamaicanNames: ['Jumbo Shrimp', 'Pepper Shrimp', 'Prawn', 'Sea Shrimp', 'Shrimp'],
    categorySlug: 'crustaceans',
    description: 'Fresh whole penaeid shrimp suited to pepper-shrimp or pan preparation.',
    referenceImageUrl: '/catalogue-photos/penaeus-spp.png',
    imageSourceLicense: 'CC BY 3.0 — Tamorlan',
    typicalUnit: ProductUnit.PER_POUND,
  },
  {
    speciesScientificName: 'Epinephelus guttatus',
    name: 'Grouper (Red Hind)',
    commonName: 'Grouper',
    jamaicanNames: ['Grouper', 'Red Hind', 'Butterfish', 'Rock Hind', 'Hind'],
    categorySlug: 'fish',
    description: 'Mild, flaky Caribbean reef grouper sold whole or scaled.',
    referenceImageUrl: '/catalogue-photos/epinephelus-guttatus.png',
    imageSourceLicense: 'CC BY-SA 3.0 — Albert kok',
    typicalUnit: ProductUnit.PER_POUND,
  },
  {
    speciesScientificName: 'Sparisoma viride',
    name: 'Parrotfish (Stoplight)',
    commonName: 'Parrotfish',
    jamaicanNames: ['Parrotfish', 'Parrot Fish', 'Parrot', 'Chub', 'Stoplight Parrotfish'],
    categorySlug: 'fish',
    description: 'Popular Jamaican reef Parrotfish ideal for roasting and steaming.',
    referenceImageUrl: '/catalogue-photos/sparisoma-viride.png',
    imageSourceLicense: 'CC BY-SA 3.0 — Adona9',
    typicalUnit: ProductUnit.PER_POUND,
  },
  {
    speciesScientificName: 'Acanthurus chirurgus',
    name: 'Doctor Fish (Surgeonfish)',
    commonName: 'Doctor Fish',
    jamaicanNames: ['Doctor Fish', 'Doctorfish', 'Surgeonfish', 'Tang'],
    categorySlug: 'fish',
    description: 'Classic Jamaican Doctor Fish prized for whole frying and tea/broth.',
    referenceImageUrl: '/catalogue-photos/acanthurus-chirurgus.png',
    imageSourceLicense: 'CC BY 2.0 — Brian Gratwicke',
    typicalUnit: ProductUnit.PER_POUND,
  },
];

export const CATALOGUE_PHOTO_DEFINITIONS: SeedCataloguePhotoDefinition[] = [
  {
    speciesScientificName: 'Lutjanus analis',
    catalogueItemName: 'Red Snapper (Fresh Whole)',
    title: 'Mutton / Red Snapper (Lutjanus analis)',
    scientificName: 'Lutjanus analis',
    jamaicanAliases: ['Red Snapper', 'Mutton Snapper', 'Snapper', 'Whole Snapper'],
    imageUrl: '/catalogue-photos/lutjanus-analis.png',
    sourceName: 'Wikimedia Commons',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Lutjanus_analis.jpg',
    photographer: 'NOAA Photo Library (SEFSC Pascagoula Laboratory; Collection of Brandi Noble)',
    licenseName: 'Public Domain (PD-USGov-NOAA)',
    licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
    modifications: 'Resized/cropped to 900x600 PNG',
    requiresAttribution: false,
    approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
  },
  {
    speciesScientificName: 'Oreochromis niloticus',
    catalogueItemName: 'Tilapia (Fresh Whole)',
    title: 'Nile Tilapia / Red Belly (Oreochromis niloticus)',
    scientificName: 'Oreochromis niloticus',
    jamaicanAliases: ['Tilapia', 'Red Belly', 'Pond Fish', 'Nile Tilapia', 'Freshwater Fish'],
    imageUrl: '/catalogue-photos/oreochromis-niloticus.png',
    sourceName: 'Wikimedia Commons',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Oreochromis-niloticus-Nairobi.JPG',
    photographer: 'Bjørn Christian Tørrissen',
    licenseName: 'CC BY-SA 3.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    modifications: 'Cropped/resized to 900x600 PNG',
    requiresAttribution: true,
    approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
  },
  {
    speciesScientificName: 'Scomberomorus cavalla',
    catalogueItemName: 'King Fish (Fresh Catch)',
    title: 'King Fish / King Mackerel (Scomberomorus cavalla)',
    scientificName: 'Scomberomorus cavalla',
    jamaicanAliases: ['Kingfish', 'King Fish', 'Cavalla', 'King Mackerel'],
    imageUrl: '/catalogue-photos/scomberomorus-cavalla.png',
    sourceName: 'Wikimedia Commons',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:King_mackerel_(_Scomberomorus_cavalla_).jpg',
    photographer: "NOAA's Fisheries Collection, SEFSC Pascagoula Laboratory; Collection of Brandi Noble",
    licenseName: 'Public Domain (PD-USGov-NOAA)',
    licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
    modifications: 'Resized/cropped to 900x600 PNG',
    requiresAttribution: false,
    approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
  },
  {
    speciesScientificName: 'Scomber scombrus',
    catalogueItemName: 'Mackerel (Fresh Whole)',
    title: 'Atlantic Mackerel on Ice (Scomber scombrus)',
    scientificName: 'Scomber scombrus',
    jamaicanAliases: ['Mackerel', 'Atlantic Mackerel', 'Tinker Mackerel', 'Salt Mackerel'],
    imageUrl: '/catalogue-photos/scomber-scombrus.png',
    sourceName: 'Wikimedia Commons',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Frozen_fresh_mackerel.jpg',
    photographer: 'Fumikas Sagisavas',
    licenseName: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    modifications: 'Cropped/resized to 900x600 PNG',
    requiresAttribution: false,
    approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
  },
  {
    speciesScientificName: 'Panulirus argus',
    catalogueItemName: 'Caribbean Spiny Lobster',
    title: 'Caribbean Spiny Lobster (Panulirus argus)',
    scientificName: 'Panulirus argus',
    jamaicanAliases: ['Spiny Lobster', 'Caribbean Spiny Lobster', 'Crayfish', 'Lobster'],
    imageUrl: '/catalogue-photos/panulirus-argus.png',
    sourceName: 'Wikimedia Commons',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Panulirus_argus_NOAA.jpg',
    photographer: 'SEFSC Pascagoula Laboratory; Collection of Brandi Noble, NOAA/NMFS/SEFSC',
    licenseName: 'Public Domain (PD-USGov-NOAA)',
    licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
    modifications: 'Resized/cropped to 900x600 PNG',
    requiresAttribution: false,
    approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
  },
  {
    speciesScientificName: 'Penaeus spp.',
    catalogueItemName: 'Jumbo Shrimp (Whole / Raw)',
    title: 'Jumbo / Tiger Shrimp (Penaeus spp.)',
    scientificName: 'Penaeus spp.',
    jamaicanAliases: ['Jumbo Shrimp', 'Pepper Shrimp', 'Prawn', 'Sea Shrimp', 'Shrimp'],
    imageUrl: '/catalogue-photos/penaeus-spp.png',
    sourceName: 'Wikimedia Commons',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Penaeus_esculentus-2009.jpg',
    photographer: 'Tamorlan',
    licenseName: 'CC BY 3.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/3.0/',
    modifications: 'Resized/cropped to 900x600 PNG',
    requiresAttribution: true,
    approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
  },
  {
    speciesScientificName: 'Epinephelus guttatus',
    catalogueItemName: 'Grouper (Red Hind)',
    title: 'Red Hind Grouper (Epinephelus guttatus)',
    scientificName: 'Epinephelus guttatus',
    jamaicanAliases: ['Grouper', 'Red Hind', 'Butterfish', 'Rock Hind', 'Hind'],
    imageUrl: '/catalogue-photos/epinephelus-guttatus.png',
    sourceName: 'Wikimedia Commons',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Epinephelus_guttatus.JPG',
    photographer: 'Albert kok',
    licenseName: 'CC BY-SA 3.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    modifications: 'Resized/cropped to 900x600 PNG',
    requiresAttribution: true,
    approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
  },
  {
    speciesScientificName: 'Sparisoma viride',
    catalogueItemName: 'Parrotfish (Stoplight)',
    title: 'Stoplight Parrotfish (Sparisoma viride)',
    scientificName: 'Sparisoma viride',
    jamaicanAliases: ['Parrotfish', 'Parrot Fish', 'Parrot', 'Chub', 'Stoplight Parrotfish'],
    imageUrl: '/catalogue-photos/sparisoma-viride.png',
    sourceName: 'Wikimedia Commons',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Stoplight-parrotfish.jpg',
    photographer: 'Adona9 at English Wikipedia',
    licenseName: 'CC BY-SA 3.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    modifications: 'Resized/cropped to 900x600 PNG',
    requiresAttribution: true,
    approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
  },
  {
    speciesScientificName: 'Acanthurus chirurgus',
    catalogueItemName: 'Doctor Fish (Surgeonfish)',
    title: 'Doctor Fish / Surgeonfish (Acanthurus chirurgus)',
    scientificName: 'Acanthurus chirurgus',
    jamaicanAliases: ['Doctor Fish', 'Doctorfish', 'Surgeonfish', 'Tang'],
    imageUrl: '/catalogue-photos/acanthurus-chirurgus.png',
    sourceName: 'Wikimedia Commons',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Doctorfish,_Acanthurus_chirurgus.jpg',
    photographer: 'Brian Gratwicke',
    licenseName: 'CC BY 2.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
    modifications: 'Resized/cropped to 900x600 PNG',
    requiresAttribution: true,
    approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
  },
];

/**
 * Idempotently upserts the Jamaican species list (preserving Conch RESTRICTED),
 * published master catalogue entries with local aliases, and verified species
 * reference photographs with rights metadata.
 */
export async function seedCataloguePhotoLibrary(prisma: PrismaClient): Promise<void> {
  const speciesByScientific = new Map<string, string>();
  for (const sp of SPECIES_DEFINITIONS) {
    const row = await prisma.species.upsert({
      where: { scientificName: sp.scientificName },
      update: { commercialName: sp.commercialName, regulatoryStatus: sp.regulatoryStatus },
      create: sp,
    });
    speciesByScientific.set(sp.scientificName, row.id);
  }

  const categories = await prisma.category.findMany();
  const categoryBySlug = new Map(categories.map((c) => [c.slug, c.id]));

  const catalogueItemByName = new Map<string, string>();
  for (const item of CATALOGUE_ITEM_DEFINITIONS) {
    const speciesId = speciesByScientific.get(item.speciesScientificName);
    const categoryId = categoryBySlug.get(item.categorySlug);
    if (!speciesId || !categoryId) {
      continue;
    }

    const existing = await prisma.seafoodCatalogueItem.findFirst({
      where: { name: { equals: item.name, mode: 'insensitive' } },
      include: { speciesLinks: true },
    });

    if (existing) {
      const updated = await prisma.seafoodCatalogueItem.update({
        where: { id: existing.id },
        data: {
          scientificName: item.speciesScientificName,
          commonName: item.commonName,
          jamaicanNames: item.jamaicanNames,
          description: existing.description ?? item.description,
          referenceImageUrl: existing.referenceImageUrl ?? item.referenceImageUrl,
          imageSourceLicense: existing.imageSourceLicense ?? item.imageSourceLicense,
          typicalUnit: item.typicalUnit,
        },
      });
      if (!existing.speciesLinks.some((l) => l.speciesId === speciesId)) {
        await prisma.catalogueItemSpecies.create({
          data: { catalogueItemId: updated.id, speciesId, isPrimary: true },
        });
      }
      catalogueItemByName.set(item.name, updated.id);
    } else {
      const created = await prisma.seafoodCatalogueItem.create({
        data: {
          name: item.name,
          scientificName: item.speciesScientificName,
          commonName: item.commonName,
          jamaicanNames: item.jamaicanNames,
          description: item.description,
          categoryId,
          compositionMode: CatalogueCompositionMode.SINGLE_SPECIES,
          lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
          referenceImageUrl: item.referenceImageUrl,
          imageSourceLicense: item.imageSourceLicense,
          typicalUnit: item.typicalUnit,
          speciesLinks: {
            create: { speciesId, isPrimary: true },
          },
        },
      });
      catalogueItemByName.set(item.name, created.id);
    }
  }

  for (const photo of CATALOGUE_PHOTO_DEFINITIONS) {
    const speciesId = speciesByScientific.get(photo.speciesScientificName);
    if (!speciesId) {
      continue;
    }
    const catalogueItemId = catalogueItemByName.get(photo.catalogueItemName) ?? null;

    await prisma.cataloguePhoto.upsert({
      where: {
        speciesId_imageUrl: {
          speciesId,
          imageUrl: photo.imageUrl,
        },
      },
      update: {
        catalogueItemId,
        title: photo.title,
        scientificName: photo.scientificName,
        jamaicanAliases: photo.jamaicanAliases,
        sourceName: photo.sourceName,
        sourceUrl: photo.sourceUrl,
        photographer: photo.photographer,
        licenseName: photo.licenseName,
        licenseUrl: photo.licenseUrl,
        modifications: photo.modifications,
        requiresAttribution: photo.requiresAttribution,
        approvalStatus: photo.approvalStatus,
      },
      create: {
        speciesId,
        catalogueItemId,
        title: photo.title,
        scientificName: photo.scientificName,
        jamaicanAliases: photo.jamaicanAliases,
        imageUrl: photo.imageUrl,
        sourceName: photo.sourceName,
        sourceUrl: photo.sourceUrl,
        photographer: photo.photographer,
        licenseName: photo.licenseName,
        licenseUrl: photo.licenseUrl,
        modifications: photo.modifications,
        requiresAttribution: photo.requiresAttribution,
        approvalStatus: photo.approvalStatus,
      },
    });
  }
}
