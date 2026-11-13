import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import {
  MAX_OPTIMIZED_IMAGE_BYTES,
  MAX_RASTER_UPLOAD_BYTES,
  ProductImageError,
  optimizeProductImage,
  resolveR2Endpoint,
} from './product-images.js'

async function createRaster(format: 'jpeg' | 'png' | 'webp', width = 64, height = 48): Promise<Buffer> {
  const image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 80, g: 150, b: 105 },
    },
  })
  if (format === 'jpeg') return image.jpeg().toBuffer()
  if (format === 'png') return image.png().toBuffer()
  return image.webp().toBuffer()
}

function svg(width: number, height: number, content = '<rect width="100%" height="100%" fill="#34885b"/>'): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${content}</svg>`)
}

test('uses the configured R2 endpoint or derives it from the account ID', () => {
  assert.equal(
    resolveR2Endpoint('test-account'),
    'https://test-account.r2.cloudflarestorage.com/',
  )
  assert.equal(
    resolveR2Endpoint('test-account', 'https://custom-r2.example.com'),
    'https://custom-r2.example.com/',
  )
  assert.throws(() => resolveR2Endpoint('test-account', 'http://insecure.example.com'), ProductImageError)
})

test('converts supported raster images into capped WebP images and smaller thumbnails', async () => {
  for (const [format, mimeType] of [
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp'],
  ] as const) {
    const result = await optimizeProductImage(await createRaster(format, 1600, 1200), mimeType)
    const mainMetadata = await sharp(result.image).metadata()
    const thumbnailMetadata = await sharp(result.thumbnail).metadata()
    assert.equal(mainMetadata.format, 'webp')
    assert.equal(thumbnailMetadata.format, 'webp')
    assert.ok(result.image.length <= MAX_OPTIMIZED_IMAGE_BYTES)
    assert.ok(mainMetadata.width && mainMetadata.width <= 1200)
    assert.ok(mainMetadata.height && mainMetadata.height <= 1200)
    assert.ok(thumbnailMetadata.width && thumbnailMetadata.width <= 320)
    assert.ok(thumbnailMetadata.height && thumbnailMetadata.height <= 320)
    assert.ok(thumbnailMetadata.width! < mainMetadata.width!)
  }
})

test('rasterizes safe SVG files and rejects active or external SVG content', async () => {
  const result = await optimizeProductImage(svg(80, 60), 'image/svg+xml')
  assert.equal((await sharp(result.image).metadata()).format, 'webp')

  await assert.rejects(
    optimizeProductImage(svg(80, 60, '<script>alert(1)</script>'), 'image/svg+xml'),
    ProductImageError,
  )
  await assert.rejects(
    optimizeProductImage(svg(80, 60, '<image href="https://example.invalid/a.png"/>'), 'image/svg+xml'),
    ProductImageError,
  )
  await assert.rejects(
    optimizeProductImage(svg(80, 60, '<rect style="fill:url(javascript:alert(1))"/>'), 'image/svg+xml'),
    ProductImageError,
  )
})

test('rejects unsupported, mismatched, oversized, and over-dimension images', async () => {
  await assert.rejects(
    optimizeProductImage(Buffer.from('not an image'), 'image/jpeg'),
    ProductImageError,
  )
  await assert.rejects(
    optimizeProductImage(Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64'), 'image/gif'),
    ProductImageError,
  )
  await assert.rejects(
    optimizeProductImage(await createRaster('png'), 'image/jpeg'),
    ProductImageError,
  )
  await assert.rejects(
    optimizeProductImage(Buffer.alloc(MAX_RASTER_UPLOAD_BYTES + 1), 'image/jpeg'),
    ProductImageError,
  )
  await assert.rejects(
    optimizeProductImage(svg(8001, 1), 'image/svg+xml'),
    ProductImageError,
  )
  await assert.rejects(
    optimizeProductImage(svg(8000, 5001), 'image/svg+xml'),
    ProductImageError,
  )
  const oversizedSvg = Buffer.concat([
    svg(1, 1),
    Buffer.alloc(2 * 1024 * 1024, 32),
  ])
  await assert.rejects(
    optimizeProductImage(oversizedSvg, 'image/svg+xml'),
    ProductImageError,
  )
})
