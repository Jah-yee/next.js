import * as path from 'path'
import * as fs from 'fs'

// Cache for fs.readdirSync lookup.
// Prevent multiple blocking IO requests that have already been calculated.
const fsReadDirSyncCache = {}

// Default page extensions used when not explicitly configured in next.config.js
const DEFAULT_PAGE_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'md', 'mdx']

/**
 * Reads `pageExtensions` from next.config.js (supports .js, .mjs, .ts).
 * Returns the configured extensions or falls back to defaults.
 */
function getPageExtensions(rootDirs: string[]): string[] {
  for (const rootDir of rootDirs) {
    for (const configName of ['next.config.mjs', 'next.config.js', 'next.config.ts']) {
      const configPath = path.join(rootDir, configName)
      if (fs.existsSync(configPath)) {
        try {
          const content = fs.readFileSync(configPath, 'utf8')
          // Match pageExtensions: ['a', 'b'] or pageExtensions: ["a", "b"]
          const match = content.match(/pageExtensions\s*:\s*\[([^\]]+)\]/)
          if (match) {
            const extensions = match[1]
              .split(',')
              .map((ext: string) => ext.trim().replace(/['"]/g, ''))
              .filter((ext: string) => ext.length > 0)
            if (extensions.length > 0) {
              return extensions
            }
          }
        } catch {
          // ignore parse errors, fall through to default
        }
        break
      }
    }
  }
  return DEFAULT_PAGE_EXTENSIONS
}

/**
 * Builds a regex that matches files with any of the given page extensions.
 */
function buildPageExtRegex(pageExtensions: string[]): RegExp {
  // Escape dots and build alternation pattern, e.g. \.(tsx|ts|jsx|js)$
  const extPattern = pageExtensions
    .map((ext) => (ext.startsWith('.') ? '\\.' + ext.slice(1) : '\\.' + ext))
    .join('|')
  return new RegExp(`\\.(${extPattern})$`)
}

/**
 * Recursively parse directory for page URLs.
 */
function parseUrlForPages(
  urlprefix: string,
  directory: string,
  pageExtRegex: RegExp
) {
  fsReadDirSyncCache[directory] ??= fs.readdirSync(directory, {
    withFileTypes: true,
  })
  const res = []
  fsReadDirSyncCache[directory].forEach((dirent) => {
    if (pageExtRegex.test(dirent.name)) {
      // index file maps to the directory itself
      if (/^index\./.test(dirent.name)) {
        res.push(`${urlprefix}${dirent.name.replace(/^index\./, '')}`)
      }
      res.push(`${urlprefix}${dirent.name.replace(pageExtRegex, '')}`)
    } else {
      const dirPath = path.join(directory, dirent.name)
      if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
        res.push(...parseUrlForPages(urlprefix + dirent.name + '/', dirPath, pageExtRegex))
      }
    }
  })
  return res
}

/**
 * Recursively parse app directory for URLs.
 * Uses fixed extensions for app router special files (page, layout, route, etc.).
 */
function parseUrlForAppDir(
  urlprefix: string,
  directory: string,
  pageExtRegex: RegExp
) {
  fsReadDirSyncCache[directory] ??= fs.readdirSync(directory, {
    withFileTypes: true,
  })
  const res = []
  // App router files use standard ts/jsx/tsx extensions (pageExtensions does not apply to app dir naming conventions)
  const appRouterExtRegex = /(\.(j|t)sx?)$/
  fsReadDirSyncCache[directory].forEach((dirent) => {
    if (appRouterExtRegex.test(dirent.name)) {
      // page.tsx files define routes
      if (/^page(\.(j|t)sx?)$/.test(dirent.name)) {
        res.push(`${urlprefix}${dirent.name.replace(/^page(\.(j|t)sx?)$/, '')}`)
      }
      // Skip layout, error, loading, not-found, route, template, default special files
      // but include other files as routes (e.g. about.tsx -> /about)
      else if (
        !/^(layout|error|loading|not-found|route|template|default)(\.(j|t)sx?)$/.test(
          dirent.name
        )
      ) {
        res.push(`${urlprefix}${dirent.name.replace(appRouterExtRegex, '')}`)
      }
    } else {
      const dirPath = path.join(directory, dirent.name)
      if (dirent.isDirectory(dirPath) && !dirent.isSymbolicLink()) {
        res.push(...parseUrlForAppDir(urlprefix + dirent.name + '/', dirPath, pageExtRegex))
      }
    }
  })
  return res
}

/**
 * Takes a URL and does the following things.
 *  - Replaces `index.html` with `/`
 *  - Makes sure all URLs are have a trailing `/`
 *  - Removes query string
 */
export function normalizeURL(url: string) {
  if (!url) {
    return
  }
  url = url.split('?', 1)[0]
  url = url.split('#', 1)[0]
  url = url = url.replace(/(\/index\.html)$/, '/')
  // Empty URLs should not be trailed with `/`, e.g. `#heading`
  if (url === '') {
    return url
  }
  url = url.endsWith('/') ? url : url + '/'
  return url
}

/**
 * Normalizes an app route so it represents the actual request path. Essentially
 * performing the following transformations:
 *
 * - `/(dashboard)/user/[id]/page` to `/user/[id]`
 * - `/(dashboard)/account/page` to `/account`
 * - `/user/[id]/page` to `/user/[id]`
 * - `/account/page` to `/account`
 * - `/page` to `/`
 * - `/(dashboard)/user/[id]/route` to `/user/[id]`
 * - `/(dashboard)/account/route` to `/account`
 * - `/user/[id]/route` to `/user/[id]`
 * - `/account/route` to `/account`
 * - `/route` to `/`
 * - `/` to `/`
 *
 * @param route the app route to normalize
 * @returns the normalized pathname
 */
export function normalizeAppPath(route: string) {
  return ensureLeadingSlash(
    route.split('/').reduce((pathname, segment, index, segments) => {
      // Empty segments are ignored.
      if (!segment) {
        return pathname
      }

      // Groups are ignored.
      if (isGroupSegment(segment)) {
        return pathname
      }

      // Parallel segments are ignored.
      if (segment[0] === '@') {
        return pathname
      }

      // The last segment (if it's a leaf) should be ignored.
      if (
        (segment === 'page' || segment === 'route') &&
        index === segments.length - 1
      ) {
        return pathname
      }

      return `${pathname}/${segment}`
    }, '')
  )
}

/**
 * Gets the possible URLs from a directory.
 * @param pageExtensions - array of page file extensions from next.config.js
 */
export function getUrlFromPagesDirectories(
  urlPrefix: string,
  directories: string[],
  pageExtensions?: string[]
) {
  const extensions = pageExtensions ?? DEFAULT_PAGE_EXTENSIONS
  const pageExtRegex = buildPageExtRegex(extensions)

  return Array.from(
    // De-duplicate similar pages across multiple directories.
    new Set(
      directories
        .flatMap((directory) => parseUrlForPages(urlPrefix, directory, pageExtRegex))
        .map(
          // Since the URLs are normalized we add `^` and `$` to the RegExp to make sure they match exactly.
          (url) => `^${normalizeURL(url)}$`
        )
    )
  ).map((urlReg) => {
    urlReg = urlReg.replace(/\[.*\]/g, '((?!.+?\\..+?).*?)')
    return new RegExp(urlReg)
  })
}

export function getUrlFromAppDirectory(
  urlPrefix: string,
  directories: string[],
  pageExtensions?: string[]
) {
  const extensions = pageExtensions ?? DEFAULT_PAGE_EXTENSIONS
  const pageExtRegex = buildPageExtRegex(extensions)

  return Array.from(
    // De-duplicate similar pages across multiple directories.
    new Set(
      directories
        .map((directory) => parseUrlForAppDir(urlPrefix, directory, pageExtRegex))
        .flat()
        .map(
          // Since the URLs are normalized we add `^` and `$` to the RegExp to make sure they match exactly.
          (url) => `^${normalizeAppPath(url)}$`
        )
    )
  ).map((urlReg) => {
    urlReg = urlReg.replace(/\[.*\]/g, '((?!.+?\\..+?).*?)')
    return new RegExp(urlReg)
  })
}

export { getPageExtensions }

export function execOnce<TArgs extends any[], TResult>(
  fn: (...args: TArgs) => TResult
): (...args: TArgs) => TResult {
  let used = false
  let result: TResult

  return (...args: TArgs) => {
    if (!used) {
      used = true
      result = fn(...args)
    }
    return result
  }
}

function ensureLeadingSlash(route: string) {
  return route.startsWith('/') ? route : `/${route}`
}

function isGroupSegment(segment: string) {
  return segment[0] === '(' && segment.endsWith(')')
}
