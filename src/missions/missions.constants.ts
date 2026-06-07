export const MISSION_CATALOG_VERSION = 'api-migration-v1'

// Describes the catalog payload exposed by the API, not the DB-keyed
// catalog_version used to look up rows. Keep this on the deployed catalog
// version; bump to 1.4.0 only after the 0014 expansion seed and public asset
// domain gate are applied in production.
export const MISSION_CONTENT_VERSION = '1.3.0'
export const MISSION_CONTENT_UPDATED_AT = '2026-05-14'
