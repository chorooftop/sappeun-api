import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import pngjs from 'pngjs'

const { PNG } = pngjs

export const ALLOWED_TEMPLATE_DIMENSIONS = new Set([128, 144])
export const MAX_TEMPLATE_SIZE_BYTES = 200 * 1024
export const TEMPLATE_VISIBLE_RGB = [255, 255, 255]
export const TEMPLATE_TRANSPARENT_RGB = [0, 0, 0]
const FOREGROUND_LUMINANCE_THRESHOLD = 210
const MIN_SOURCE_ALPHA = 16
const MIN_COMPONENT_PIXELS = 8

function assertPngSignature(buffer, filePath) {
  const signature = buffer.subarray(0, 8).toString('hex')
  if (signature !== '89504e470d0a1a0a') {
    throw new Error(`Expected PNG artwork: ${filePath}`)
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function readPng(buffer, filePath) {
  assertPngSignature(buffer, filePath)
  try {
    return PNG.sync.read(buffer)
  } catch (error) {
    throw new Error(
      `Invalid PNG artwork ${filePath}: ${error?.message ?? error}`,
    )
  }
}

export function normalizeTemplatePngBuffer(buffer, filePath = '<buffer>') {
  const png = readPng(buffer, filePath)
  const pixelCount = png.width * png.height
  const candidates = new Uint8Array(pixelCount)
  const luminance = new Float32Array(pixelCount)

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const index = pixel * 4
    const red = png.data[index]
    const green = png.data[index + 1]
    const blue = png.data[index + 2]
    const alpha = png.data[index + 3]
    const value = (red + green + blue) / 3
    luminance[pixel] = value
    if (alpha >= MIN_SOURCE_ALPHA && value < FOREGROUND_LUMINANCE_THRESHOLD) {
      candidates[pixel] = 1
    }
  }

  const kept = new Uint8Array(pixelCount)
  const alphaByPixel = new Uint8Array(pixelCount)
  const visited = new Uint8Array(pixelCount)
  const queue = []
  const component = []

  for (let start = 0; start < pixelCount; start += 1) {
    if (!candidates[start] || visited[start]) continue

    queue.length = 0
    component.length = 0
    queue.push(start)
    visited[start] = 1

    let minX = png.width
    let minY = png.height
    let maxX = -1
    let maxY = -1
    let minLum = 255
    let touchesEdge = false

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const pixel = queue[cursor]
      component.push(pixel)
      const x = pixel % png.width
      const y = Math.floor(pixel / png.width)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
      minLum = Math.min(minLum, luminance[pixel])
      touchesEdge ||= x === 0 || y === 0 || x === png.width - 1 || y === png.height - 1

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= png.width || ny < 0 || ny >= png.height) continue
          const next = ny * png.width + nx
          if (!candidates[next] || visited[next]) continue
          visited[next] = 1
          queue.push(next)
        }
      }
    }

    const boxWidth = maxX - minX + 1
    const boxHeight = maxY - minY + 1
    const isLargeBackground =
      boxWidth > png.width * 0.92 && boxHeight > png.height * 0.92
    if (
      component.length < MIN_COMPONENT_PIXELS ||
      touchesEdge ||
      isLargeBackground
    ) {
      continue
    }

    const range = Math.max(1, FOREGROUND_LUMINANCE_THRESHOLD - minLum)
    for (const pixel of component) {
      const normalized =
        (FOREGROUND_LUMINANCE_THRESHOLD - luminance[pixel]) / range
      const alpha = Math.max(
        1,
        Math.min(255, Math.round(Math.pow(normalized, 0.7) * 255)),
      )
      kept[pixel] = 1
      alphaByPixel[pixel] = alpha
    }
  }

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const index = pixel * 4
    if (!kept[pixel]) {
      png.data[index] = TEMPLATE_TRANSPARENT_RGB[0]
      png.data[index + 1] = TEMPLATE_TRANSPARENT_RGB[1]
      png.data[index + 2] = TEMPLATE_TRANSPARENT_RGB[2]
      png.data[index + 3] = 0
      continue
    }

    png.data[index] = TEMPLATE_VISIBLE_RGB[0]
    png.data[index + 1] = TEMPLATE_VISIBLE_RGB[1]
    png.data[index + 2] = TEMPLATE_VISIBLE_RGB[2]
    png.data[index + 3] = alphaByPixel[pixel]
  }

  return PNG.sync.write(png)
}

export function analyzeTemplatePngBuffer(buffer, filePath = '<buffer>') {
  const png = readPng(buffer, filePath)
  const totalPixels = png.width * png.height
  const alphaValues = new Set()
  let visiblePixels = 0
  let transparentPixels = 0
  let canonicalRgbPixels = 0
  let transparentRgbPixels = 0
  let minX = png.width
  let minY = png.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const index = (y * png.width + x) * 4
      const red = png.data[index]
      const green = png.data[index + 1]
      const blue = png.data[index + 2]
      const alpha = png.data[index + 3]
      alphaValues.add(alpha)

      if (alpha === 0) {
        transparentPixels += 1
        if (
          red === TEMPLATE_TRANSPARENT_RGB[0] &&
          green === TEMPLATE_TRANSPARENT_RGB[1] &&
          blue === TEMPLATE_TRANSPARENT_RGB[2]
        ) {
          transparentRgbPixels += 1
        }
        continue
      }

      visiblePixels += 1
      if (
        red === TEMPLATE_VISIBLE_RGB[0] &&
        green === TEMPLATE_VISIBLE_RGB[1] &&
        blue === TEMPLATE_VISIBLE_RGB[2]
      ) {
        canonicalRgbPixels += 1
      }
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  return {
    width: png.width,
    height: png.height,
    byteLength: buffer.length,
    hash: sha256(buffer),
    totalPixels,
    visiblePixels,
    transparentPixels,
    transparentRatio: totalPixels === 0 ? 0 : transparentPixels / totalPixels,
    alphaValueCount: alphaValues.size,
    canonicalRgbPixels,
    transparentRgbPixels,
    boundingBox:
      visiblePixels === 0
        ? null
        : {
            minX,
            minY,
            maxX,
            maxY,
            width: maxX - minX + 1,
            height: maxY - minY + 1,
          },
  }
}

export function validateTemplatePngBuffer(buffer, filePath = '<buffer>') {
  const analysis = analyzeTemplatePngBuffer(buffer, filePath)
  const issues = []
  const warnings = []

  if (analysis.byteLength > MAX_TEMPLATE_SIZE_BYTES) {
    issues.push(`size exceeds ${MAX_TEMPLATE_SIZE_BYTES} bytes`)
  }
  if (analysis.width !== analysis.height) {
    issues.push(`canvas must be square, got ${analysis.width}x${analysis.height}`)
  }
  if (!ALLOWED_TEMPLATE_DIMENSIONS.has(analysis.width)) {
    issues.push(
      `canvas must be 128x128 or 144x144, got ${analysis.width}x${analysis.height}`,
    )
  }
  if (analysis.visiblePixels === 0) {
    issues.push('alpha matte is empty')
  }
  if (analysis.canonicalRgbPixels !== analysis.visiblePixels) {
    issues.push('visible pixels must all be #FFFFFF')
  }
  if (analysis.transparentRgbPixels !== analysis.transparentPixels) {
    issues.push('transparent pixels must all be #000000')
  }
  if (analysis.boundingBox) {
    const fillsCanvas =
      analysis.boundingBox.minX === 0 &&
      analysis.boundingBox.minY === 0 &&
      analysis.boundingBox.maxX === analysis.width - 1 &&
      analysis.boundingBox.maxY === analysis.height - 1
    if (fillsCanvas) {
      issues.push('alpha bounding box fills the entire canvas')
    }
  }
  if (analysis.transparentRatio < 0.02) {
    issues.push('transparent pixel ratio is below 2%')
  }
  if (analysis.alphaValueCount <= 2) {
    warnings.push('alpha matte has little or no antialiasing')
  }

  if (issues.length > 0) {
    throw new Error(`Invalid template PNG ${filePath}: ${issues.join('; ')}`)
  }

  return { ...analysis, warnings }
}

export function validateTemplatePngFile(filePath) {
  return validateTemplatePngBuffer(readFileSync(filePath), filePath)
}

export function validateManifestTemplateImages(manifest, repoRoot) {
  const warnings = []
  let totalBytes = 0

  for (const image of manifest.images ?? []) {
    const filePath = resolve(repoRoot, image.file)
    const analysis = validateTemplatePngFile(filePath)
    totalBytes += analysis.byteLength
    warnings.push(
      ...analysis.warnings.map((warning) => ({
        missionId: image.missionId,
        file: image.file,
        warning,
      })),
    )

    const artwork = image.artwork
    if (artwork?.type !== 'remoteImage') {
      throw new Error(`Expected remoteImage artwork for ${image.missionId}`)
    }
    if (artwork.mimeType !== 'image/png') {
      throw new Error(`Expected image/png artwork for ${image.missionId}`)
    }
    if (artwork.paletteMode !== 'mono') {
      throw new Error(`Expected mono paletteMode for ${image.missionId}`)
    }
    if (artwork.width !== analysis.width || artwork.height !== analysis.height) {
      throw new Error(`Artwork dimensions do not match PNG for ${image.missionId}`)
    }
    if (artwork.contentHash !== `sha256:${analysis.hash}`) {
      throw new Error(`Artwork contentHash does not match PNG for ${image.missionId}`)
    }
  }

  return {
    count: manifest.images?.length ?? 0,
    totalBytes,
    warnings,
    firstObjectKey: manifest.images?.[0]?.objectKey ?? null,
    lastObjectKey: manifest.images?.at(-1)?.objectKey ?? null,
  }
}
