import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const MAX_CHAT_MESSAGES = 20
export const MAX_MESSAGE_CHARS = 4000
export const MAX_REQUEST_BODY_BYTES = 64 * 1024
export const ALLOWED_GEMINI_MODELS = new Set([
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash'
])

const isRedisConfigured = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
)
const isProductionEnvironment = Boolean(process.env.NODE_ENV === 'production' || process.env.VERCEL)
const localRateLimitStore = new Map<string, { count: number, resetAt: number }>()

export type ChatMessage = {
  role: string
  content: string
}

export interface RouteRateLimitPolicy {
  name: string
  max: number
  windowMs: number
  sensitive: boolean
  allowLocalFallback?: boolean
}

export function getClientIp(req: Pick<IncomingMessage, 'headers' | 'socket'> & { body?: unknown }): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim()
  }
  if (Array.isArray(forwarded) && forwarded.length > 0 && forwarded[0]) {
    return forwarded[0].trim()
  }
  const cfConnectingIp = req.headers['cf-connecting-ip']
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) {
    return cfConnectingIp.trim()
  }
  const remoteAddress = req.socket?.remoteAddress
  return remoteAddress || 'unknown-client'
}

export function validateChatRequest(body: unknown): { ok: true, model: string, messages: ChatMessage[] } | { ok: false, status: number, error: string } {
  try {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ok: false, status: 400, error: 'Request body must be a JSON object.' }
    }

    const payload = body as Record<string, unknown>
    if (payload.messages === undefined || !Array.isArray(payload.messages)) {
      return { ok: false, status: 400, error: 'Messages array is required.' }
    }

    if (JSON.stringify(payload).length > MAX_REQUEST_BODY_BYTES) {
      return { ok: false, status: 413, error: 'Request body exceeds the 64 KB limit.' }
    }

    if (payload.messages.length === 0 || payload.messages.length > MAX_CHAT_MESSAGES) {
      return { ok: false, status: 400, error: `Messages must contain between 1 and ${MAX_CHAT_MESSAGES} entries.` }
    }

    const sanitizedMessages: ChatMessage[] = payload.messages.map((message) => {
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        throw new Error('Each message must be an object.')
      }

      const candidate = message as Record<string, unknown>
      const role = typeof candidate.role === 'string' ? candidate.role.trim().toLowerCase() : ''
      const content = typeof candidate.content === 'string' ? candidate.content : ''

      if (!['user', 'assistant'].includes(role)) {
        throw new Error('Each message role must be user or assistant.')
      }

      if (content.length === 0 || content.length > MAX_MESSAGE_CHARS) {
        throw new Error(`Each message must be 1-${MAX_MESSAGE_CHARS} characters.`)
      }

      return { role, content }
    })

    let model = 'gemini-2.5-flash'
    if (payload.model !== undefined) {
      if (typeof payload.model !== 'string' || !payload.model.trim()) {
        return { ok: false, status: 400, error: 'Model must be a non-empty string.' }
      }
      model = payload.model.trim()
      if (!ALLOWED_GEMINI_MODELS.has(model)) {
        return { ok: false, status: 400, error: 'Unsupported model selected. Use a server-approved Gemini model.' }
      }
    }

    return { ok: true, model, messages: sanitizedMessages }
  } catch {
    return { ok: false, status: 400, error: 'Each message must be a valid user or assistant object within the 4,000 character limit.' }
  }
}

export function getRateLimitPolicies(): Record<string, RouteRateLimitPolicy> {
  return {
    '/api/auth/login': { name: 'auth-login', max: 5, windowMs: 15 * 60 * 1000, sensitive: true },
    '/api/auth/signup': { name: 'auth-signup', max: 5, windowMs: 60 * 60 * 1000, sensitive: true },
    '/api/auth/verify': { name: 'auth-verify', max: 5, windowMs: 15 * 60 * 1000, sensitive: true },
    '/api/auth/resend-verification': { name: 'auth-resend-verification', max: 3, windowMs: 15 * 60 * 1000, sensitive: true },
    '/api/auth/change-password': { name: 'auth-change-password', max: 5, windowMs: 15 * 60 * 1000, sensitive: true },
    '/api/auth/change-email': { name: 'auth-change-email', max: 5, windowMs: 15 * 60 * 1000, sensitive: true },
    '/api/auth/confirm-email-change': { name: 'auth-confirm-email-change', max: 5, windowMs: 15 * 60 * 1000, sensitive: true },
    '/api/chat': { name: 'chat', max: 10, windowMs: 60 * 1000, sensitive: false, allowLocalFallback: true },
    '/api/admin': { name: 'admin', max: 20, windowMs: 60 * 1000, sensitive: true },
    '/api/admin/login': { name: 'admin-login', max: 5, windowMs: 15 * 60 * 1000, sensitive: true },
    '/api/admin/products/upload': { name: 'admin-upload', max: 10, windowMs: 60 * 1000, sensitive: true },
    '/api/auth/profile': { name: 'profile', max: 60, windowMs: 60 * 1000, sensitive: false, allowLocalFallback: true },
    '/api/auth/orders': { name: 'orders', max: 60, windowMs: 60 * 1000, sensitive: false, allowLocalFallback: true },
    '/api/auth/reviews': { name: 'reviews', max: 60, windowMs: 60 * 1000, sensitive: false, allowLocalFallback: true }
  }
}

export function getRateLimitPolicy(pathname: string | undefined): RouteRateLimitPolicy | undefined {
  if (!pathname) return undefined
  const normalizedPath = pathname.replace(/\/+$/, '') || '/'
  const policies = getRateLimitPolicies()
  if (normalizedPath === '/api/admin' || normalizedPath.startsWith('/api/admin/')) {
    if (normalizedPath === '/api/admin/login') return policies['/api/admin/login']
    return policies['/api/admin']
  }
  return policies[normalizedPath]
}

let redisClient: Redis | null = null

export function getRedisClient(): Redis | null {
  if (!isRedisConfigured) return null
  if (!redisClient) {
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!
    })
  }
  return redisClient
}

function checkLocalRateLimit(policy: RouteRateLimitPolicy, key: string): { success: boolean, reset: number } | null {
  const now = Date.now()
  const bucket = localRateLimitStore.get(`${policy.name}:${key}`)

  if (!bucket || bucket.resetAt <= now) {
    localRateLimitStore.set(`${policy.name}:${key}`, { count: 1, resetAt: now + policy.windowMs })
    return { success: true, reset: Math.ceil((now + policy.windowMs - now) / 1000) }
  }

  if (bucket.count >= policy.max) {
    return { success: false, reset: Math.ceil((bucket.resetAt - now) / 1000) }
  }

  bucket.count += 1
  localRateLimitStore.set(`${policy.name}:${key}`, bucket)
  return { success: true, reset: Math.ceil((bucket.resetAt - now) / 1000) }
}

async function checkRedisRateLimit(policy: RouteRateLimitPolicy, key: string): Promise<{ success: boolean, reset: number, limit: number, remaining: number } | null> {
  const redis = getRedisClient()
  if (!redis) {
    return null
  }
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(policy.max, `${policy.windowMs} ms`),
    analytics: false,
    prefix: `aurel:${policy.name}`
  })
  const result = await limiter.limit(key)
  return {
    success: result.success,
    reset: result.reset,
    limit: result.limit,
    remaining: result.remaining
  }
}

export async function enforceRouteRateLimit(req: Pick<IncomingMessage, 'headers' | 'socket' | 'url' | 'method'> & { body?: unknown }, res: ServerResponse, policy: RouteRateLimitPolicy, accountKey?: string): Promise<boolean> {
  const clientIp = getClientIp(req)
  const ipKey = `ip:${clientIp}`
  const keys = [ipKey]
  if (accountKey && accountKey.trim()) keys.push(`account:${accountKey.toLowerCase()}`)

  const redisResult = await Promise.all(
    keys.map(async (key) => checkRedisRateLimit(policy, key))
  )

  if (redisResult.some(result => result && !result.success)) {
    const retryAfter = Math.max(...redisResult.filter(Boolean).map(result => Number(result?.reset ?? 0))) || Math.ceil(policy.windowMs / 1000)
    res.statusCode = 429
    res.setHeader('Retry-After', String(retryAfter))
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'Too many requests. Please slow down and try again.' }))
    return false
  }

  if (redisResult.every(result => result === null)) {
    const localResults = keys.map(key => checkLocalRateLimit(policy, key))
    const blocked = localResults.some(result => result && !result.success)
    if (blocked) {
      const retryAfter = Math.max(...localResults.filter(Boolean).map(result => Number(result?.reset ?? 0))) || Math.ceil(policy.windowMs / 1000)
      res.statusCode = 429
      res.setHeader('Retry-After', String(retryAfter))
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'Too many requests. Please slow down and try again.' }))
      return false
    }

    if (policy.sensitive && isProductionEnvironment) {
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'Rate limiting is temporarily unavailable. Please try again later.' }))
      return false
    }
    return true
  }

  return true
}
