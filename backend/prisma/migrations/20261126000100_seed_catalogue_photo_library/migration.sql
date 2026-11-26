-- Additive Data Migration #72: Idempotent Catalogue Species & Photo Library Seed
-- Populates the expanded Jamaican species list (preserving Conch as RESTRICTED),
-- master catalogue entries with Jamaican market aliases, and approved species
-- reference photos with provenance/licensing metadata during `prisma migrate deploy`.

INSERT INTO "categories" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'Fish', 'fish', NOW(), NOW()),
  (gen_random_uuid()::text, 'Crustaceans', 'crustaceans', NOW(), NOW())
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "species" (
  "id",
  "scientificName",
  "commercialName",
  "regulatoryStatus",
  "createdAt",
  "updatedAt"
)
VALUES
  (gen_random_uuid()::text, 'Lutjanus analis', 'Snapper', 'UNRESTRICTED'::"RegulatoryStatus", NOW(), NOW()),
  (gen_random_uuid()::text, 'Scomberomorus cavalla', 'King Fish', 'UNRESTRICTED'::"RegulatoryStatus", NOW(), NOW()),
  (gen_random_uuid()::text, 'Scomber scombrus', 'Mackerel', 'UNRESTRICTED'::"RegulatoryStatus", NOW(), NOW()),
  (gen_random_uuid()::text, 'Panulirus argus', 'Lobster', 'UNRESTRICTED'::"RegulatoryStatus", NOW(), NOW()),
  (gen_random_uuid()::text, 'Penaeus spp.', 'Shrimp', 'UNRESTRICTED'::"RegulatoryStatus", NOW(), NOW()),
  (gen_random_uuid()::text, 'Lobatus gigas', 'Conch', 'RESTRICTED'::"RegulatoryStatus", NOW(), NOW()),
  (gen_random_uuid()::text, 'Oreochromis niloticus', 'Tilapia', 'UNRESTRICTED'::"RegulatoryStatus", NOW(), NOW()),
  (gen_random_uuid()::text, 'Epinephelus guttatus', 'Grouper', 'UNRESTRICTED'::"RegulatoryStatus", NOW(), NOW()),
  (gen_random_uuid()::text, 'Sparisoma viride', 'Parrotfish', 'UNRESTRICTED'::"RegulatoryStatus", NOW(), NOW()),
  (gen_random_uuid()::text, 'Acanthurus chirurgus', 'Doctor Fish', 'UNRESTRICTED'::"RegulatoryStatus", NOW(), NOW())
ON CONFLICT ("scientificName") DO NOTHING;

INSERT INTO "seafood_catalogue_items" (
  "id",
  "name",
  "scientificName",
  "commonName",
  "jamaicanNames",
  "description",
  "categoryId",
  "compositionMode",
  "lifecycleStatus",
  "referenceImageUrl",
  "imageSourceLicense",
  "typicalUnit",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  v."name",
  v."scientificName",
  v."commonName",
  v."jamaicanNames",
  v."description",
  COALESCE(
    (SELECT c."id" FROM "categories" c WHERE c."slug" = v."categorySlug" LIMIT 1),
    (SELECT c."id" FROM "categories" c ORDER BY c."createdAt" ASC LIMIT 1)
  ),
  'SINGLE_SPECIES'::"CatalogueCompositionMode",
  'PUBLISHED'::"CatalogueLifecycleStatus",
  v."referenceImageUrl",
  v."imageSourceLicense",
  v."typicalUnit"::"ProductUnit",
  NOW(),
  NOW()
FROM (
  VALUES
    (
      'Red Snapper (Fresh Whole)',
      'Lutjanus analis',
      'Red Snapper',
      ARRAY['Red Snapper', 'Mutton Snapper', 'Snapper', 'Whole Snapper', 'Roast Fish Snapper']::TEXT[],
      'Whole fresh Mutton/Red Snapper landed by Jamaican inshore and bank fishers.',
      'fish',
      '/catalogue-photos/lutjanus-analis.png',
      'Public Domain (PD-USGov-NOAA) — NOAA Photo Library',
      'PER_POUND'
    ),
    (
      'Tilapia (Fresh Whole)',
      'Oreochromis niloticus',
      'Tilapia',
      ARRAY['Tilapia', 'Red Belly', 'Pond Fish', 'Nile Tilapia', 'Freshwater Fish']::TEXT[],
      'Fresh whole farm-raised Jamaican Tilapia, ideal for escovitch or steaming.',
      'fish',
      '/catalogue-photos/oreochromis-niloticus.png',
      'CC BY-SA 3.0 — Bjørn Christian Tørrissen',
      'PER_POUND'
    ),
    (
      'King Fish (Fresh Catch)',
      'Scomberomorus cavalla',
      'King Fish',
      ARRAY['Kingfish', 'King Fish', 'Cavalla', 'King Mackerel', 'Kingfish Steak']::TEXT[],
      'Firm-fleshed coastal King Fish prized for steaks and escovitch.',
      'fish',
      '/catalogue-photos/scomberomorus-cavalla.png',
      'Public Domain (PD-USGov-NOAA) — SEFSC Pascagoula Laboratory',
      'PER_POUND'
    ),
    (
      'Mackerel (Fresh Whole)',
      'Scomber scombrus',
      'Mackerel',
      ARRAY['Mackerel', 'Atlantic Mackerel', 'Tinker Mackerel', 'Salt Mackerel']::TEXT[],
      'Oil-rich whole mackerel popular across Jamaican markets.',
      'fish',
      '/catalogue-photos/scomber-scombrus.png',
      'CC0 1.0 — Fumikas Sagisavas',
      'PER_POUND'
    ),
    (
      'Caribbean Spiny Lobster',
      'Panulirus argus',
      'Spiny Lobster',
      ARRAY['Spiny Lobster', 'Caribbean Spiny Lobster', 'Crayfish', 'Lobster']::TEXT[],
      'Whole Caribbean Spiny Lobster caught cleanly in seasonal traps.',
      'crustaceans',
      '/catalogue-photos/panulirus-argus.png',
      'Public Domain (PD-USGov-NOAA) — SEFSC Pascagoula Laboratory',
      'PER_ITEM'
    ),
    (
      'Jumbo Shrimp (Whole / Raw)',
      'Penaeus spp.',
      'Jumbo Shrimp',
      ARRAY['Jumbo Shrimp', 'Pepper Shrimp', 'Prawn', 'Sea Shrimp', 'Shrimp']::TEXT[],
      'Fresh whole penaeid shrimp suited to pepper-shrimp or pan preparation.',
      'crustaceans',
      '/catalogue-photos/penaeus-spp.png',
      'CC BY 3.0 — Tamorlan',
      'PER_POUND'
    ),
    (
      'Grouper (Red Hind)',
      'Epinephelus guttatus',
      'Grouper',
      ARRAY['Grouper', 'Red Hind', 'Butterfish', 'Rock Hind', 'Hind']::TEXT[],
      'Mild, flaky Caribbean reef grouper sold whole or scaled.',
      'fish',
      '/catalogue-photos/epinephelus-guttatus.png',
      'CC BY-SA 3.0 — Albert kok',
      'PER_POUND'
    ),
    (
      'Parrotfish (Stoplight)',
      'Sparisoma viride',
      'Parrotfish',
      ARRAY['Parrotfish', 'Parrot Fish', 'Parrot', 'Chub', 'Stoplight Parrotfish']::TEXT[],
      'Popular Jamaican reef Parrotfish ideal for roasting and steaming.',
      'fish',
      '/catalogue-photos/sparisoma-viride.png',
      'CC BY-SA 3.0 — Adona9',
      'PER_POUND'
    ),
    (
      'Doctor Fish (Surgeonfish)',
      'Acanthurus chirurgus',
      'Doctor Fish',
      ARRAY['Doctor Fish', 'Doctorfish', 'Surgeonfish', 'Tang']::TEXT[],
      'Classic Jamaican Doctor Fish prized for whole frying and tea/broth.',
      'fish',
      '/catalogue-photos/acanthurus-chirurgus.png',
      'CC BY 2.0 — Brian Gratwicke',
      'PER_POUND'
    )
) AS v(
  "name",
  "scientificName",
  "commonName",
  "jamaicanNames",
  "description",
  "categorySlug",
  "referenceImageUrl",
  "imageSourceLicense",
  "typicalUnit"
)
WHERE NOT EXISTS (
  SELECT 1
  FROM "seafood_catalogue_items" existing
  WHERE existing."name" = v."name"
     OR lower(COALESCE(existing."scientificName", '')) = lower(v."scientificName")
);

INSERT INTO "catalogue_item_species" ("catalogueItemId", "speciesId", "isPrimary", "typicalProportion", "createdAt")
SELECT
  ci."id",
  sp."id",
  true,
  1.00,
  NOW()
FROM "seafood_catalogue_items" ci
JOIN "species" sp ON lower(COALESCE(ci."scientificName", '')) = lower(sp."scientificName")
WHERE sp."scientificName" IN (
  'Lutjanus analis',
  'Oreochromis niloticus',
  'Scomberomorus cavalla',
  'Scomber scombrus',
  'Panulirus argus',
  'Penaeus spp.',
  'Epinephelus guttatus',
  'Sparisoma viride',
  'Acanthurus chirurgus'
)
ON CONFLICT ("catalogueItemId", "speciesId") DO NOTHING;

INSERT INTO "catalogue_photos" (
  "id",
  "speciesId",
  "catalogueItemId",
  "title",
  "scientificName",
  "jamaicanAliases",
  "imageUrl",
  "sourceName",
  "sourceUrl",
  "photographer",
  "licenseName",
  "licenseUrl",
  "modifications",
  "requiresAttribution",
  "approvalStatus",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  sp."id",
  (
    SELECT ci."id"
    FROM "seafood_catalogue_items" ci
    WHERE ci."name" = p."catalogueItemName"
       OR lower(COALESCE(ci."scientificName", '')) = lower(p."scientificName")
    ORDER BY ci."createdAt" ASC
    LIMIT 1
  ),
  p."title",
  p."scientificName",
  p."jamaicanAliases",
  p."imageUrl",
  p."sourceName",
  p."sourceUrl",
  p."photographer",
  p."licenseName",
  p."licenseUrl",
  p."modifications",
  p."requiresAttribution",
  'APPROVED'::"CataloguePhotoApprovalStatus",
  NOW(),
  NOW()
FROM (
  VALUES
    (
      'Lutjanus analis',
      'Red Snapper (Fresh Whole)',
      'Mutton / Red Snapper (Lutjanus analis)',
      ARRAY['Red Snapper', 'Mutton Snapper', 'Snapper', 'Whole Snapper']::TEXT[],
      '/catalogue-photos/lutjanus-analis.png',
      'Wikimedia Commons',
      'https://commons.wikimedia.org/wiki/File:Lutjanus_analis.jpg',
      'NOAA Photo Library (SEFSC Pascagoula Laboratory; Collection of Brandi Noble)',
      'Public Domain (PD-USGov-NOAA)',
      'https://creativecommons.org/publicdomain/mark/1.0/',
      'Resized/cropped to 900x600 PNG',
      false
    ),
    (
      'Oreochromis niloticus',
      'Tilapia (Fresh Whole)',
      'Nile Tilapia / Red Belly (Oreochromis niloticus)',
      ARRAY['Tilapia', 'Red Belly', 'Pond Fish', 'Nile Tilapia', 'Freshwater Fish']::TEXT[],
      '/catalogue-photos/oreochromis-niloticus.png',
      'Wikimedia Commons',
      'https://commons.wikimedia.org/wiki/File:Oreochromis-niloticus-Nairobi.JPG',
      'Bjørn Christian Tørrissen',
      'CC BY-SA 3.0',
      'https://creativecommons.org/licenses/by-sa/3.0/',
      'Cropped/resized to 900x600 PNG',
      true
    ),
    (
      'Scomberomorus cavalla',
      'King Fish (Fresh Catch)',
      'King Fish / King Mackerel (Scomberomorus cavalla)',
      ARRAY['Kingfish', 'King Fish', 'Cavalla', 'King Mackerel']::TEXT[],
      '/catalogue-photos/scomberomorus-cavalla.png',
      'Wikimedia Commons',
      'https://commons.wikimedia.org/wiki/File:King_mackerel_(_Scomberomorus_cavalla_).jpg',
      'NOAA''s Fisheries Collection, SEFSC Pascagoula Laboratory; Collection of Brandi Noble',
      'Public Domain (PD-USGov-NOAA)',
      'https://creativecommons.org/publicdomain/mark/1.0/',
      'Resized/cropped to 900x600 PNG',
      false
    ),
    (
      'Scomber scombrus',
      'Mackerel (Fresh Whole)',
      'Atlantic Mackerel on Ice (Scomber scombrus)',
      ARRAY['Mackerel', 'Atlantic Mackerel', 'Tinker Mackerel', 'Salt Mackerel']::TEXT[],
      '/catalogue-photos/scomber-scombrus.png',
      'Wikimedia Commons',
      'https://commons.wikimedia.org/wiki/File:Frozen_fresh_mackerel.jpg',
      'Fumikas Sagisavas',
      'CC0 1.0',
      'https://creativecommons.org/publicdomain/zero/1.0/',
      'Cropped/resized to 900x600 PNG',
      false
    ),
    (
      'Panulirus argus',
      'Caribbean Spiny Lobster',
      'Caribbean Spiny Lobster (Panulirus argus)',
      ARRAY['Spiny Lobster', 'Caribbean Spiny Lobster', 'Crayfish', 'Lobster']::TEXT[],
      '/catalogue-photos/panulirus-argus.png',
      'Wikimedia Commons',
      'https://commons.wikimedia.org/wiki/File:Panulirus_argus_NOAA.jpg',
      'SEFSC Pascagoula Laboratory; Collection of Brandi Noble, NOAA/NMFS/SEFSC',
      'Public Domain (PD-USGov-NOAA)',
      'https://creativecommons.org/publicdomain/mark/1.0/',
      'Resized/cropped to 900x600 PNG',
      false
    ),
    (
      'Penaeus spp.',
      'Jumbo Shrimp (Whole / Raw)',
      'Jumbo / Tiger Shrimp (Penaeus spp.)',
      ARRAY['Jumbo Shrimp', 'Pepper Shrimp', 'Prawn', 'Sea Shrimp', 'Shrimp']::TEXT[],
      '/catalogue-photos/penaeus-spp.png',
      'Wikimedia Commons',
      'https://commons.wikimedia.org/wiki/File:Penaeus_esculentus-2009.jpg',
      'Tamorlan',
      'CC BY 3.0',
      'https://creativecommons.org/licenses/by/3.0/',
      'Resized/cropped to 900x600 PNG',
      true
    ),
    (
      'Epinephelus guttatus',
      'Grouper (Red Hind)',
      'Red Hind Grouper (Epinephelus guttatus)',
      ARRAY['Grouper', 'Red Hind', 'Butterfish', 'Rock Hind', 'Hind']::TEXT[],
      '/catalogue-photos/epinephelus-guttatus.png',
      'Wikimedia Commons',
      'https://commons.wikimedia.org/wiki/File:Epinephelus_guttatus.JPG',
      'Albert kok',
      'CC BY-SA 3.0',
      'https://creativecommons.org/licenses/by-sa/3.0/',
      'Resized/cropped to 900x600 PNG',
      true
    ),
    (
      'Sparisoma viride',
      'Parrotfish (Stoplight)',
      'Stoplight Parrotfish (Sparisoma viride)',
      ARRAY['Parrotfish', 'Parrot Fish', 'Parrot', 'Chub', 'Stoplight Parrotfish']::TEXT[],
      '/catalogue-photos/sparisoma-viride.png',
      'Wikimedia Commons',
      'https://commons.wikimedia.org/wiki/File:Stoplight-parrotfish.jpg',
      'Adona9 at English Wikipedia',
      'CC BY-SA 3.0',
      'https://creativecommons.org/licenses/by-sa/3.0/',
      'Resized/cropped to 900x600 PNG',
      true
    ),
    (
      'Acanthurus chirurgus',
      'Doctor Fish (Surgeonfish)',
      'Doctor Fish / Surgeonfish (Acanthurus chirurgus)',
      ARRAY['Doctor Fish', 'Doctorfish', 'Surgeonfish', 'Tang']::TEXT[],
      '/catalogue-photos/acanthurus-chirurgus.png',
      'Wikimedia Commons',
      'https://commons.wikimedia.org/wiki/File:Doctorfish,_Acanthurus_chirurgus.jpg',
      'Brian Gratwicke',
      'CC BY 2.0',
      'https://creativecommons.org/licenses/by/2.0/',
      'Resized/cropped to 900x600 PNG',
      true
    )
) AS p(
  "scientificName",
  "catalogueItemName",
  "title",
  "jamaicanAliases",
  "imageUrl",
  "sourceName",
  "sourceUrl",
  "photographer",
  "licenseName",
  "licenseUrl",
  "modifications",
  "requiresAttribution"
)
JOIN "species" sp ON sp."scientificName" = p."scientificName"
ON CONFLICT ("speciesId", "imageUrl") DO NOTHING;
