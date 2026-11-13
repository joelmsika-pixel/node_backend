import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { randomUUID } from 'node:crypto'
import sharp, { type Metadata } from 'sharp'

export const MAX_PRODUCT_IMAGES = 5
export const MAX_RASTER_UPLOAD_BYTES = 8 * 1024 * 1024
export const MAX_SVG_UPLOAD_BYTES = 2 * 1024 * 1024
export const MAX_PRODUCT_UPLOAD_BYTES = 40 * 1024 * 1024
export const MAX_SOURCE_IMAGE_DIMENSION = 8000
export const MAX_SOURCE_IMAGE_PIXELS = 40_000_000
export const MAX_OPTIMIZED_IMAGE_BYTES = 200_000
export const PRODUCT_IMAGE_BUCKET = 'biashara-manager-products'

export class ProductImageError extends Error {
  status: number

  constructor(message: string, status = 422) {
    super(message)
    this.name = 'ProductImageError'
    this.status = status
  }
}

export type OptimizedProductImage = {
  image: Buffer
  thumbnail: Buffer
  width: number
  height: number
}

export type ProductImageKeys = {
  imageKey: string
  thumbnailKey: string
}

let r2Client: S3Client | undefined

export function resolveR2Endpoint(accountId: string, configuredEndpoint?: string): string {
  const endpoint = configuredEndpoint?.trim()
    || `https://${accountId}.r2.cloudflarestorage.com`
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new ProductImageError('R2_ENDPOINT must be a valid HTTPS URL.', 503)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ProductImageError('R2_ENDPOINT must be a valid HTTPS URL.', 503)
  }
  return parsed.toString()
}

function r2Config() {
  const accountId = process.env.R2_ACCOUNT_ID?.trim()
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim()
  const bucketName = process.env.R2_BUCKET_NAME?.trim()
  const publicUrl = process.env.R2_PUBLIC_URL?.trim().replace(/\/+$/, '')
  const configuredEndpoint = process.env.R2_ENDPOINT?.trim()
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !publicUrl) return null
  if (bucketName !== PRODUCT_IMAGE_BUCKET) {
    throw new ProductImageError(`R2_BUCKET_NAME must be ${PRODUCT_IMAGE_BUCKET}.`, 503)
  }
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    publicUrl,
    endpoint: resolveR2Endpoint(accountId, configuredEndpoint),
  }
}

export function isProductImageStorageConfigured(): boolean {
  return r2Config() !== null
}

function getR2Client(): { client: S3Client; bucketName: string; publicUrl: string } {
  const config = r2Config()
  if (!config) throw new ProductImageError('Product image storage is not configured.', 503)
  if (!r2Client) {
    r2Client = new S3Client({
      region: 'auto',
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    })
  }
  return { client: r2Client, bucketName: config.bucketName, publicUrl: config.publicUrl }
}

export function productImageUrl(objectKey: string): string {
  const publicUrl = process.env.R2_PUBLIC_URL?.trim().replace(/\/+$/, '')
  if (!publicUrl) throw new ProductImageError('Product image storage is not configured.', 503)
  return `${publicUrl}/${objectKey.split('/').map(encodeURIComponent).join('/')}`
}

export function productImageKeys(businessId: number, productId: number): ProductImageKeys {
  const prefix = `businesses/${businessId}/products/${productId}/${randomUUID()}`
  return { imageKey: `${prefix}.webp`, thumbnailKey: `${prefix}-thumb.webp` }
}

export async function uploadProductImageObject(objectKey: string, body: Buffer): Promise<void> {
  const { client, bucketName } = getR2Client()
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Body: body,
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable',
    }))
  } catch (error) {
    console.error('Cloudflare R2 product image upload failed:', error)
    throw new ProductImageError('Product image storage is unavailable. Try again later.', 502)
  }
}

export async function deleteProductImageObject(objectKey: string): Promise<void> {
  const { client, bucketName } = getR2Client()
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey }))
  } catch (error) {
    console.error('Cloudflare R2 product image deletion failed:', error)
    throw new ProductImageError('A product image could not be removed from storage.', 502)
  }
}

function validateSvg(buffer: Buffer): void {
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new ProductImageError('The SVG must use valid UTF-8 text.')
  }

  if (
    /<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|\bon[a-z]+\s*=|@import/i.test(source)
    || /(?:href|xlink:href)\s*=\s*(["'])(?!#)[\s\S]*?\1/i.test(source)
    || /url\(\s*["']?(?!#)[^)]+\)/i.test(source)
  ) {
    throw new ProductImageError('This SVG contains unsupported scripts or external references.')
  }
}

export async function optimizeProductImage(
  buffer: Buffer,
  declaredMimeType: string,
): Promise<OptimizedProductImage> {
  if (!buffer.length || buffer.length > MAX_RASTER_UPLOAD_BYTES) {
    throw new ProductImageError('Each image must not exceed 8 MiB.')
  }

  const image = sharp(buffer, {
    failOn: 'error',
    limitInputPixels: MAX_SOURCE_IMAGE_PIXELS,
    density: 96,
  })
  let metadata: Metadata
  try {
    metadata = await image.metadata()
  } catch {
    throw new ProductImageError('The selected file is not a valid supported image.')
  }

  const format = metadata.format
  const acceptedFormats = new Set(['jpeg', 'png', 'webp', 'svg'])
  if (!format || !acceptedFormats.has(format)) {
    throw new ProductImageError('Upload a JPG, PNG, WebP, or SVG image.')
  }

  if (format === 'svg') {
    if (buffer.length > MAX_SVG_UPLOAD_BYTES) throw new ProductImageError('Each SVG must not exceed 2 MiB.')
    if (declaredMimeType && !['image/svg+xml', 'application/octet-stream', 'text/xml', 'application/xml'].includes(declaredMimeType)) {
      throw new ProductImageError('The SVG content type is invalid.')
    }
    validateSvg(buffer)
  }

  const expectedMimeType: Record<string, string> = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  }
  if (
    declaredMimeType
    && declaredMimeType !== 'application/octet-stream'
    && declaredMimeType !== expectedMimeType[format]
    && !(format === 'svg' && ['text/xml', 'application/xml'].includes(declaredMimeType))
  ) {
    throw new ProductImageError('The image content type is invalid.')
  }

  const width = metadata.width
  const height = metadata.height
  if (
    !width || !height
    || width > MAX_SOURCE_IMAGE_DIMENSION
    || height > MAX_SOURCE_IMAGE_DIMENSION
    || width * height > MAX_SOURCE_IMAGE_PIXELS
  ) {
    throw new ProductImageError('Images must be at most 8,000 px per side and 40 megapixels.')
  }

  const sizeLimits = [1200, 1000, 800, 640, 480, 320]
  const qualities = [82, 76, 70, 64, 58, 52, 46]
  for (const size of sizeLimits) {
    for (const quality of qualities) {
      const optimized = await sharp(buffer, {
        failOn: 'error',
        limitInputPixels: MAX_SOURCE_IMAGE_PIXELS,
        density: 96,
      })
        .rotate()
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality, effort: 4 })
        .toBuffer({ resolveWithObject: true })

      if (optimized.data.length <= MAX_OPTIMIZED_IMAGE_BYTES) {
        const thumbnail = await sharp(optimized.data)
          .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 76, effort: 4 })
          .toBuffer()
        return {
          image: optimized.data,
          thumbnail,
          width: optimized.info.width,
          height: optimized.info.height,
        }
      }
    }
  }

  throw new ProductImageError('This image could not be optimized below 200 KB. Try a simpler or smaller image.')
}
