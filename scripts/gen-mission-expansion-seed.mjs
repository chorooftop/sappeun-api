#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { validateTemplatePngFile } from './mission-artwork-template-utils.mjs'

export const CATALOG_VERSION = 'api-migration-v1'
export const EXPANSION_VERSION = '1.4.0'
export const EXPANSION_UPDATED_AT = '2026-06-07'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

export const RAW_NODE_EXPORT_DIR = resolve(
  repoRoot,
  'artifacts/mission-artwork/v1.4-pencil-export/raw-node-export',
)
export const ARTWORK_IMAGE_DIR = resolve(
  repoRoot,
  'artifacts/mission-artwork/v1.4-pencil-export/png',
)
export const ARTWORK_MANIFEST_PATH = resolve(
  repoRoot,
  'artifacts/mission-artwork/v1.4-pencil-export/manifest.json',
)
export const MIGRATION_PATH = resolve(
  repoRoot,
  'supabase/migrations/0014_bingo_mission_expansion.sql',
)

const ARTWORK_BASE_URL = 'https://assets.sappeun.app'
const BASE_SORT_ORDER = 480
const SORT_STEP = 10
const RUNTIME_CAPABILITY = 'runtime-artwork-v1'
const SWATCH_HEX_CAPABILITY = 'swatch-hex-v1'

const CATEGORY_META = {
  nature: { label: '자연·식물', tone: 'brand-primary' },
  manmade: { label: '인공물', tone: 'brand-primary' },
  animal: { label: '동물', tone: 'brand-primary' },
  time: { label: '시간·숫자', tone: 'brand-primary' },
  self: { label: '셀프', tone: 'cat-self' },
  color: { label: '색깔', tone: 'cat-color' },
  special: { label: '특수', tone: 'brand-accent' },
}

const VARIANT_BY_CATEGORY = {
  self: 'k4Srv',
  special: 'rAdyJ',
}

const COLOR_SWATCHES = {
  orange: { label: '주황', colorHex: '#F59E0B' },
  purple: { label: '보라', colorHex: '#A855F7' },
  brown: { label: '갈색', colorHex: '#8B5E3C' },
  gray: { label: '회색', colorHex: '#9CA3AF' },
  gold: { label: '금색', colorHex: '#D4AF37' },
  silver: { label: '은색', colorHex: '#CBD5E1' },
  neon: { label: '형광', colorHex: '#BEF264' },
}

export const EXPANSION_MISSIONS = [
  // nature n09-n32
  { id: 'n09', category: 'nature', label: '소나무', icon: 'tree-pine', nodeId: '0GkZi' },
  { id: 'n10', category: 'nature', label: '단풍', icon: 'tree-deciduous', nodeId: 'VSmvg' },
  { id: 'n11', category: 'nature', label: '잡초·풀숲', icon: 'shrub', nodeId: '21dTj' },
  { id: 'n12', category: 'nature', label: '노을', icon: 'sunset', nodeId: '8lcTk' },
  { id: 'n13', category: 'nature', label: '아침 햇살', icon: 'sunrise', nodeId: 'IUbjR' },
  { id: 'n14', category: 'nature', label: '빗방울', icon: 'droplet', nodeId: 'hQWqO' },
  { id: 'n15', category: 'nature', label: '물웅덩이', icon: 'droplets', nodeId: 'MOW1A' },
  { id: 'n16', category: 'nature', label: '안개', icon: 'cloud-fog', nodeId: 'Ub5cs' },
  { id: 'n17', category: 'nature', label: '바람', icon: 'wind', nodeId: 't1JQi' },
  { id: 'n18', category: 'nature', label: '깃털', icon: 'feather', nodeId: 'fjy6N' },
  { id: 'n19', category: 'nature', label: '열매', icon: 'cherry', nodeId: 'KLm8c' },
  { id: 'n20', category: 'nature', label: '산·언덕', icon: 'mountain', nodeId: 'RZm3d' },
  { id: 'n21', category: 'nature', label: '이끼', icon: 'sprout', nodeId: '80qiJ' },
  { id: 'n22', category: 'nature', label: '솔방울', icon: 'tree-pine', nodeId: 'YzEI5' },
  { id: 'n23', category: 'nature', label: '도토리', icon: 'cherry', nodeId: '2Z7TU' },
  { id: 'n24', category: 'nature', label: '거미줄', icon: 'bug', nodeId: 'CMYxY' },
  { id: 'n25', category: 'nature', label: '그루터기', icon: 'trees', nodeId: 'wsDUb' },
  { id: 'n26', category: 'nature', label: '덩굴', icon: 'leaf', nodeId: 'moa7V' },
  { id: 'n27', category: 'nature', label: '연못', icon: 'waves', nodeId: 'nqJ22' },
  { id: 'n28', category: 'nature', label: '새싹', icon: 'sprout', nodeId: 'FeO0w' },
  { id: 'n29', category: 'nature', label: '낙엽', icon: 'leaf', nodeId: '6GW2x' },
  { id: 'n30', category: 'nature', label: '바위', icon: 'mountain', nodeId: 'hYVwT' },
  { id: 'n31', category: 'nature', label: '조약돌', icon: 'circle', nodeId: 'jlroT' },
  { id: 'n32', category: 'nature', label: '갈대', icon: 'wheat', nodeId: 'Kwhig' },

  // manmade m11-m42
  { id: 'm11', category: 'manmade', label: '버스 정류장', icon: 'bus', nodeId: 'lFYq9' },
  { id: 'm12', category: 'manmade', label: '자동차', icon: 'car', nodeId: 'CyCNc' },
  { id: 'm13', category: 'manmade', label: '비행기', icon: 'plane', nodeId: '6FzsU' },
  { id: 'm14', category: 'manmade', label: '깃발', icon: 'flag', nodeId: 'T10ge' },
  { id: 'm15', category: 'manmade', label: '자물쇠', icon: 'lock', nodeId: 'Oczd3' },
  { id: 'm16', category: 'manmade', label: '문·대문', icon: 'door-open', nodeId: 'IRxXD' },
  { id: 'm17', category: 'manmade', label: '가게 간판', icon: 'store', nodeId: 'ObBTv' },
  { id: 'm18', category: 'manmade', label: '커피잔', icon: 'coffee', nodeId: 'CuNSG' },
  { id: 'm19', category: 'manmade', label: '빵', icon: 'croissant', nodeId: 'foQtI' },
  { id: 'm20', category: 'manmade', label: '책', icon: 'book-open', nodeId: 'Kp1Ej' },
  { id: 'm21', category: 'manmade', label: '쓰레기통', icon: 'trash-2', nodeId: 'Oh2kQ' },
  { id: 'm22', category: 'manmade', label: '화살표', icon: 'arrow-right', nodeId: 'zCTXv' },
  { id: 'm23', category: 'manmade', label: '계단', icon: 'chevron-up', nodeId: 'YnhRN' },
  { id: 'm24', category: 'manmade', label: '맨홀 뚜껑', icon: 'circle', nodeId: 'kYBv3' },
  { id: 'm25', category: 'manmade', label: '신호등', icon: 'traffic-cone', nodeId: '38K3U' },
  { id: 'm26', category: 'manmade', label: '소화전', icon: 'fuel', nodeId: 'xZykk' },
  { id: 'm27', category: 'manmade', label: '기차·전철', icon: 'tram-front', nodeId: 'aNVsf' },
  { id: 'm28', category: 'manmade', label: '버스', icon: 'bus', nodeId: 'tUjnv' },
  { id: 'm29', category: 'manmade', label: '오토바이', icon: 'bike', nodeId: 'VErAI' },
  { id: 'm30', category: 'manmade', label: '분수대', icon: 'droplets', nodeId: 'UlSfH' },
  { id: 'm31', category: 'manmade', label: '놀이터', icon: 'ferris-wheel', nodeId: '2Fk21' },
  { id: 'm32', category: 'manmade', label: '동상·조각상', icon: 'person-standing', nodeId: 'Fpdmc' },
  { id: 'm33', category: 'manmade', label: '다리', icon: 'spline', nodeId: 'rFekC' },
  { id: 'm34', category: 'manmade', label: '창문', icon: 'square', nodeId: 'kazca' },
  { id: 'm35', category: 'manmade', label: '지붕', icon: 'house', nodeId: 'wTQMi' },
  { id: 'm36', category: 'manmade', label: '벽돌 벽', icon: 'brick-wall', nodeId: 'wje0p' },
  { id: 'm37', category: 'manmade', label: '보도블록', icon: 'grid-3x3', nodeId: 'yVYcS' },
  { id: 'm38', category: 'manmade', label: '전봇대', icon: 'utility-pole', nodeId: 'adT49' },
  { id: 'm39', category: 'manmade', label: '실외기·환풍구', icon: 'air-vent', nodeId: 'NIR9f' },
  { id: 'm40', category: 'manmade', label: '빨래', icon: 'shirt', nodeId: '3NcKo' },
  { id: 'm41', category: 'manmade', label: '현금인출기', icon: 'landmark', nodeId: 'kr6Eb' },
  { id: 'm42', category: 'manmade', label: 'CCTV', icon: 'cctv', nodeId: 'viXtq' },

  // animal a07-a18
  { id: 'a07', category: 'animal', label: '다람쥐', icon: 'squirrel', nodeId: 'bUPiA' },
  { id: 'a08', category: 'animal', label: '달팽이', icon: 'snail', nodeId: 'U0I2w' },
  { id: 'a09', category: 'animal', label: '거북이', icon: 'turtle', nodeId: 'OMKOJ' },
  { id: 'a10', category: 'animal', label: '동물 발자국', icon: 'paw-print', nodeId: 'OyAE7' },
  { id: 'a11', category: 'animal', label: '오리', icon: 'bird', nodeId: '5KsZw' },
  { id: 'a12', category: 'animal', label: '토끼', icon: 'rabbit', nodeId: 'xkTLl' },
  { id: 'a13', category: 'animal', label: '벌', icon: 'bug', nodeId: 'MK0wS' },
  { id: 'a14', category: 'animal', label: '무당벌레', icon: 'bug', nodeId: 'FI2dd' },
  { id: 'a15', category: 'animal', label: '잠자리', icon: 'bug', nodeId: 'atlp7' },
  { id: 'a16', category: 'animal', label: '까치·까마귀', icon: 'bird', nodeId: 'slGSQ' },
  { id: 'a17', category: 'animal', label: '개미', icon: 'bug', nodeId: 'PDKzA' },
  { id: 'a18', category: 'animal', label: '새 둥지', icon: 'egg', nodeId: '3WxhH' },

  // time t07-t21
  { id: 't07', category: 'time', label: '8', textOnly: true, fontSize: 34, nodeId: 'VRUh9' },
  { id: 't08', category: 'time', label: '3', textOnly: true, fontSize: 34, nodeId: 'YgDe5' },
  { id: 't09', category: 'time', label: 'S', textOnly: true, fontSize: 30, nodeId: 'YV5SV' },
  { id: 't10', category: 'time', label: 'A', textOnly: true, fontSize: 30, nodeId: '2Uhw8' },
  { id: 't11', category: 'time', label: '동그라미', icon: 'circle', nodeId: 'MeUPS' },
  { id: 't12', category: 'time', label: '세모', icon: 'triangle', nodeId: 'W9MEe' },
  { id: 't13', category: 'time', label: '하트 모양', icon: 'heart', nodeId: '0C5lE' },
  { id: 't14', category: 'time', label: '더하기·십자', icon: 'plus', nodeId: 'RuUY7' },
  { id: 't15', category: 'time', label: '0', textOnly: true, fontSize: 34, nodeId: 'cZgxi' },
  { id: 't16', category: 'time', label: '9', textOnly: true, fontSize: 34, nodeId: 'yqpr6' },
  { id: 't17', category: 'time', label: 'O', textOnly: true, fontSize: 30, nodeId: '63Xon' },
  { id: 't18', category: 'time', label: '네모', icon: 'square', nodeId: '3copK' },
  { id: 't19', category: 'time', label: '마름모', icon: 'diamond', nodeId: 'HV5K7' },
  { id: 't20', category: 'time', label: '줄무늬', icon: 'equal', nodeId: 'YMWmS' },
  { id: 't21', category: 'time', label: '물방울무늬', icon: 'grip', nodeId: 'TPQNs' },

  // color c09-c15
  { id: 'c09', category: 'color', label: '주황색', swatch: 'orange', nodeId: 'pgFWY' },
  { id: 'c10', category: 'color', label: '보라색', swatch: 'purple', nodeId: 'gg70L' },
  { id: 'c11', category: 'color', label: '갈색', swatch: 'brown', nodeId: '7rOYi' },
  { id: 'c12', category: 'color', label: '회색', swatch: 'gray', nodeId: 'rpsjg' },
  { id: 'c13', category: 'color', label: '금색', swatch: 'gold', nodeId: 'wkkgv' },
  { id: 'c14', category: 'color', label: '은색', swatch: 'silver', nodeId: 'MD5xT' },
  { id: 'c15', category: 'color', label: '형광색', swatch: 'neon', nodeId: 'b8ZkD' },

  // self sf10-sf21
  { id: 'sf10', category: 'self', label: '안경 셀카', icon: 'glasses', camera: 'front', nodeId: 'RJe7k' },
  { id: 'sf11', category: 'self', label: '점프 셀카', icon: 'person-standing', camera: 'back', nodeId: 'nEBAK' },
  { id: 'sf12', category: 'self', label: '오늘의 가방', icon: 'backpack', camera: 'back', nodeId: 'rsr8b' },
  { id: 'sf13', category: 'self', label: '음료 한 컷', icon: 'cup-soda', camera: 'front', nodeId: '7XSSW' },
  { id: 'sf14', category: 'self', label: '오늘의 음악', icon: 'headphones', camera: 'front', nodeId: '8Poh9' },
  { id: 'sf15', category: 'self', label: '손 흔들기', icon: 'hand', camera: 'front', nodeId: '05jJt' },
  { id: 'sf16', category: 'self', label: '발 모아 찍기', icon: 'footprints', camera: 'back', nodeId: 'kJSe0' },
  { id: 'sf17', category: 'self', label: '모자 셀카', icon: 'crown', camera: 'front', nodeId: 'mcZb7' },
  { id: 'sf18', category: 'self', label: '하늘 배경 셀카', icon: 'cloud', camera: 'front', nodeId: 'ukUTt' },
  { id: 'sf19', category: 'self', label: '풍경과 함께', icon: 'mountain', camera: 'back', nodeId: 'Gidw0' },
  { id: 'sf20', category: 'self', label: '기지개', icon: 'person-standing', camera: 'back', nodeId: 'QU6EF' },
  { id: 'sf21', category: 'self', label: '오늘의 액세서리', icon: 'watch', camera: 'front', nodeId: 'PUYJA' },
]

function sqlString(value) {
  if (value == null) return 'null'
  return `'${String(value).replace(/'/g, "''")}'`
}

function sqlBool(value) {
  if (value == null) return 'null'
  return value ? 'true' : 'false'
}

function sqlNumber(value) {
  if (value == null) return 'null'
  return String(value)
}

function capabilityArray(capabilities) {
  return `array[${capabilities
    .map((capability) => `${sqlString(capability)}::text`)
    .join(', ')}]`
}

function jsonbLiteral(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`
}

function defaultHint(mission) {
  if (mission.category === 'color') {
    return `${mission.label}: 그 색이 잘 보이는 물건이나 풍경을 찾아요`
  }

  if (mission.category === 'self') {
    return `${mission.label}: 포즈나 소품이 잘 드러나게 찍어요`
  }

  if (mission.category === 'time' && mission.textOnly) {
    if (/^\d$/.test(mission.label)) {
      return `숫자 ${mission.label}가 보이는 간판·주소·번호판을 찾아요`
    }
    return `${mission.label} 글자가 보이는 간판·로고·문구를 찾아요`
  }

  if (mission.category === 'time') {
    return `${mission.label}: 간판·소품·장식에서 같은 모양을 찾아요`
  }

  if (mission.category === 'animal') {
    return `${mission.label}: 동물을 방해하지 않고 멀리서 담아요`
  }

  if (mission.category === 'manmade') {
    return `${mission.label}: 길가나 건물 주변에서 보이는 장면을 담아요`
  }

  return `${mission.label}: 자연물이 잘 보이는 장면을 담아요`
}

function captureLabel(mission) {
  if (mission.captureLabel) return mission.captureLabel
  if (mission.category === 'color') return mission.label
  if (mission.category !== 'time' || !mission.textOnly) return null
  if (/^\d$/.test(mission.label)) return `숫자 ${mission.label}`
  return `${mission.label} 글자`
}

function caption(mission) {
  if (mission.caption) return mission.caption
  if (mission.category === 'color') return '색 찾기'
  if (mission.category !== 'time' || !mission.textOnly) return null
  return /^\d$/.test(mission.label) ? '숫자 찾기' : '글자 찾기'
}

function fallbackArtwork(mission) {
  const base = {
    schemaVersion: 1,
    alt: mission.label,
  }

  if (mission.textOnly) {
    return {
      ...base,
      type: 'text',
      label: mission.label,
      fontSize: mission.fontSize,
      paletteMode: 'mono',
    }
  }

  if (mission.swatch) {
    const swatch = COLOR_SWATCHES[mission.swatch]
    return {
      ...base,
      type: 'swatch',
      key: mission.swatch,
      colorHex: swatch.colorHex,
      label: swatch.label,
      effect: 'solid',
    }
  }

  return {
    ...base,
    type: 'lucide',
    key: mission.icon,
    paletteMode: 'mono',
  }
}

function requiredCapabilities(mission) {
  const caps = [RUNTIME_CAPABILITY]
  if (mission.category === 'color') caps.push(SWATCH_HEX_CAPABILITY)
  return caps
}

function normalizeMission(mission, index) {
  const swatch = mission.swatch ? COLOR_SWATCHES[mission.swatch] : null
  return {
    ...mission,
    hint: mission.hint ?? defaultHint(mission),
    caption: caption(mission),
    captureLabel: captureLabel(mission),
    icon: mission.textOnly || mission.swatch ? null : mission.icon,
    variant: VARIANT_BY_CATEGORY[mission.category] ?? 'QeQCU',
    difficulty: mission.difficulty ?? null,
    camera: mission.camera ?? null,
    textOnly: mission.textOnly ?? null,
    fontSize: mission.fontSize ?? null,
    swatchLabel: swatch?.label ?? null,
    colorHex: swatch?.colorHex ?? null,
    noPhoto: null,
    fixedPosition: null,
    awardsBadge: true,
    sortOrder: BASE_SORT_ORDER + index * SORT_STEP,
    requiredCapabilities: requiredCapabilities(mission),
    fallback: fallbackArtwork(mission),
  }
}

function inspectPng(filePath) {
  const buffer = readFileSync(filePath)
  const analysis = validateTemplatePngFile(filePath)
  return {
    buffer,
    width: analysis.width,
    height: analysis.height,
  }
}

function ensureImageFile(mission) {
  const target = resolve(ARTWORK_IMAGE_DIR, `${mission.id}.png`)
  if (existsSync(target)) return target

  const source = resolve(RAW_NODE_EXPORT_DIR, `${mission.nodeId}.png`)
  throw new Error(
    `Missing normalized artwork for ${mission.id}: expected ${target}. Run pnpm normalize:mission-artwork first. Raw source: ${source}`,
  )
}

function buildRemoteArtwork(mission, imagePath) {
  const image = inspectPng(imagePath)
  const hash = createHash('sha256').update(image.buffer).digest('hex')
  const assetId = `mission_${mission.id}_v14`
  const objectKey = `mission-artwork/${assetId}.${hash.slice(0, 12)}.png`
  return {
    schemaVersion: 1,
    type: 'remoteImage',
    assetId,
    url: `${ARTWORK_BASE_URL}/${objectKey}`,
    contentHash: `sha256:${hash}`,
    mimeType: 'image/png',
    width: image.width,
    height: image.height,
    paletteMode: 'mono',
    fit: 'contain',
    fallback: mission.fallback,
  }
}

function buildContentTuple(row) {
  return `  (${[
    sqlString(row.id),
    sqlString(CATALOG_VERSION),
    sqlString(row.label),
    sqlString(row.category),
    sqlString(row.hint),
    sqlString(row.caption),
    sqlString(row.captureLabel),
    sqlString(row.icon),
    sqlString(row.variant),
    sqlString(row.difficulty),
    sqlString(row.camera),
    sqlBool(row.textOnly),
    sqlNumber(row.fontSize),
    sqlString(row.swatch ?? null),
    sqlString(row.swatchLabel),
    sqlBool(row.noPhoto),
    sqlString(row.fixedPosition),
    sqlBool(row.awardsBadge),
    sqlNumber(row.sortOrder),
    'true',
    jsonbLiteral(row.artwork),
    capabilityArray(row.requiredCapabilities),
  ].join(', ')})`
}

function buildCategoryTuple([key, meta]) {
  return `  (${[
    sqlString(CATALOG_VERSION),
    sqlString(key),
    sqlString(meta.label),
    sqlString(meta.tone),
  ].join(', ')})`
}

export function buildExpansionArtifacts() {
  const rows = EXPANSION_MISSIONS.map((mission, index) => {
    const normalized = normalizeMission(mission, index)
    const imagePath = ensureImageFile(normalized)
    return {
      ...normalized,
      imagePath,
      artwork: buildRemoteArtwork(normalized, imagePath),
    }
  })

  const contentValues = rows.map(buildContentTuple).join(',\n')
  const categoryValues = Object.entries(CATEGORY_META)
    .map(buildCategoryTuple)
    .join(',\n')

  const migrationSql = `-- 0014_bingo_mission_expansion.sql
-- Adds the v1.4 bingo mission expansion from:
-- /Users/oksang/Desktop/sappeun/sappeun-frontend/plans/bingo-mission-expansion-candidates.md
--
-- The original 48-cell 0010 seed remains immutable. These 102 new rows are
-- runtime-artwork gated so older clients keep receiving the legacy catalog.
-- Badge identity is derived from mission_content; this migration intentionally
-- does not insert mission_badges rows or stored category counts.

alter table public.mission_content
  add column if not exists awards_badge boolean not null default true;

insert into public.mission_content (
  mission_id, catalog_version, label, category, hint, caption, capture_label,
  icon, variant, difficulty, camera, text_only, font_size, swatch, swatch_label,
  no_photo, fixed_position, awards_badge, sort_order, active, artwork, required_capabilities
)
values
${contentValues}
on conflict (catalog_version, mission_id) do update
  set
      label = excluded.label,
      category = excluded.category,
      hint = excluded.hint,
      caption = excluded.caption,
      capture_label = excluded.capture_label,
      icon = excluded.icon,
      variant = excluded.variant,
      difficulty = excluded.difficulty,
      camera = excluded.camera,
      text_only = excluded.text_only,
      font_size = excluded.font_size,
      swatch = excluded.swatch,
      swatch_label = excluded.swatch_label,
      no_photo = excluded.no_photo,
      fixed_position = excluded.fixed_position,
      awards_badge = excluded.awards_badge,
      sort_order = excluded.sort_order,
      active = excluded.active,
      artwork = excluded.artwork,
      required_capabilities = excluded.required_capabilities;

insert into public.mission_categories (
  catalog_version, key, label, tone
)
values
${categoryValues}
on conflict (catalog_version, key) do update
  set
      label = excluded.label,
      tone = excluded.tone;

notify pgrst, 'reload schema';
`

  const manifest = {
    version: EXPANSION_VERSION,
    updatedAt: EXPANSION_UPDATED_AT,
    sourcePlan:
      '/Users/oksang/Desktop/sappeun/sappeun-frontend/plans/bingo-mission-expansion-candidates.md',
    sourceDesign:
      '/Users/oksang/Desktop/sappeun/sappeun-frontend/design_v2.pen#05. Illustration Master Reference Export',
    publicBaseUrl: ARTWORK_BASE_URL,
    uploadEnvRequired: [
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_PUBLIC_ASSET_BUCKET',
      'R2_PUBLIC_ASSET_BASE_URL',
    ],
    count: rows.length,
    images: rows.map((row) => ({
      missionId: row.id,
      category: row.category,
      label: row.label,
      pencilNodeId: row.nodeId,
      file: row.imagePath.replace(`${repoRoot}/`, ''),
      objectKey: new URL(row.artwork.url).pathname.slice(1),
      artwork: row.artwork,
    })),
  }

  return { rows, migrationSql, manifest }
}

function main() {
  const { migrationSql, manifest } = buildExpansionArtifacts()
  mkdirSync(dirname(MIGRATION_PATH), { recursive: true })
  mkdirSync(dirname(ARTWORK_MANIFEST_PATH), { recursive: true })
  writeFileSync(MIGRATION_PATH, migrationSql)
  writeFileSync(ARTWORK_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${MIGRATION_PATH}`)
  console.log(`Wrote ${ARTWORK_MANIFEST_PATH}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
