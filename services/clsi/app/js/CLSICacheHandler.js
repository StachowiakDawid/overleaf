const fs = require('node:fs')
const Path = require('node:path')
const { pipeline } = require('node:stream/promises')
const { createGzip, createGunzip } = require('node:zlib')
const tarFs = require('tar-fs')
const _ = require('lodash')
const {
  fetchNothing,
  fetchStream,
  RequestFailedError,
} = require('@overleaf/fetch-utils')
const logger = require('@overleaf/logger')
const Metrics = require('@overleaf/metrics')
const Settings = require('@overleaf/settings')
const { CACHE_SUBDIR } = require('./OutputCacheManager')
const { isExtraneousFile } = require('./ResourceWriter')

const TIMING_BUCKETS = [
  0, 10, 100, 1000, 2000, 5000, 10000, 15000, 20000, 30000,
]
const MAX_ENTRIES_IN_OUTPUT_TAR = 100

/**
 * @param {string} projectId
 * @param {string} userId
 * @param {string} buildId
 * @param {string} editorId
 * @param {[{path: string}]} outputFiles
 * @param {string} compileGroup
 */
function notifyCLSICacheAboutBuild({
  projectId,
  userId,
  buildId,
  editorId,
  outputFiles,
  compileGroup,
}) {
  if (!Settings.apis.clsiCache.enabled) return

  /**
   * @param {[{path: string}]} files
   */
  const enqueue = files => {
    Metrics.count('clsi_cache_enqueue_files', files.length)
    fetchNothing(`${Settings.apis.clsiCache.url}/enqueue`, {
      method: 'POST',
      json: {
        projectId,
        userId,
        buildId,
        editorId,
        files,
        downloadHost: Settings.apis.clsi.downloadHost,
        clsiServerId: Settings.apis.clsi.clsiServerId,
        compileGroup,
      },
      signal: AbortSignal.timeout(15_000),
    }).catch(err => {
      logger.warn(
        { err, projectId, userId, buildId },
        'enqueue for clsi cache failed'
      )
    })
  }

  // PDF preview
  enqueue(
    outputFiles
      .filter(
        f =>
          f.path === 'output.pdf' ||
          f.path === 'output.log' ||
          f.path.endsWith('.blg')
      )
      .map(f => {
        if (f.path === 'output.pdf') {
          return _.pick(f, 'path', 'size', 'contentId', 'ranges')
        }
        return _.pick(f, 'path')
      })
  )

  // Compile Cache
  buildTarball({ projectId, userId, buildId, outputFiles })
    .then(() => {
      enqueue([{ path: 'output.tar.gz' }])
    })
    .catch(err => {
      logger.warn(
        { err, projectId, userId, buildId },
        'build output.tar.gz for clsi cache failed'
      )
    })
}

/**
 * @param {string} projectId
 * @param {string} userId
 * @param {string} buildId
 * @param {[{path: string}]} outputFiles
 * @return {Promise<void>}
 */
async function buildTarball({ projectId, userId, buildId, outputFiles }) {
  const timer = new Metrics.Timer('clsi_cache_build', 1, {}, TIMING_BUCKETS)
  const outputDir = Path.join(
    Settings.path.outputDir,
    userId ? `${projectId}-${userId}` : projectId,
    CACHE_SUBDIR,
    buildId
  )

  const files = outputFiles.filter(
    f => f.path === 'output.synctex.gz' || !isExtraneousFile(f.path)
  )
  if (files.length > MAX_ENTRIES_IN_OUTPUT_TAR) {
    Metrics.inc('clsi_cache_build_too_many_entries')
    throw new Error('too many output files for output.tar.gz')
  }
  Metrics.count('clsi_cache_build_files', files.length)

  const path = Path.join(outputDir, 'output.tar.gz')
  try {
    await pipeline(
      tarFs.pack(outputDir, { entries: files.map(f => f.path) }),
      createGzip(),
      fs.createWriteStream(path)
    )
  } catch (err) {
    try {
      await fs.promises.unlink(path)
    } catch (e) {}
    throw err
  } finally {
    timer.done()
  }
}

/**
 * @param {string} projectId
 * @param {string} userId
 * @param {string} compileDir
 * @return {Promise<boolean>}
 */
async function downloadLatestCompileCache(projectId, userId, compileDir) {
  return await _downloadCompileCache(
    `${Settings.apis.clsiCache.url}/project/${projectId}/${
      userId ? `user/${userId}/` : ''
    }latest/output/output.tar.gz`,
    compileDir,
    'tar'
  )
}

/**
 * @param {string} projectId
 * @param {string} userId
 * @param {string} editorId
 * @param {string} buildId
 * @param {string} compileDir
 * @return {Promise<boolean>}
 */
async function downloadOldCompileCache(
  projectId,
  userId,
  editorId,
  buildId,
  compileDir
) {
  return await _downloadCompileCache(
    `${Settings.apis.clsiCache.url}/project/${projectId}/${
      userId ? `user/${userId}/` : ''
    }build/${editorId}-${buildId}/search/output/output.tar.gz`,
    compileDir,
    'synctex'
  )
}

/**
 * @param {string} url
 * @param {string} compileDir
 * @param {string} method
 * @return {Promise<boolean>}
 */
async function _downloadCompileCache(url, compileDir, method) {
  if (!Settings.apis.clsiCache.enabled) return false

  const timer = new Metrics.Timer(
    'clsi_cache_download',
    1,
    { status: 'success', method },
    TIMING_BUCKETS
  )
  let stream
  try {
    stream = await fetchStream(url, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    if (err instanceof RequestFailedError && err.response.status === 404) {
      timer.labels.status = 'not-found'
      timer.done()
      return false
    }
    timer.labels.status = 'error'
    timer.done()
    throw err
  }
  let n = 0
  let abort = false
  await pipeline(
    stream,
    createGunzip(),
    tarFs.extract(compileDir, {
      // use ignore hook for counting entries (files+folders) and validation.
      // Include folders as they incur mkdir calls.
      ignore(_, header) {
        if (abort) return true // log once
        n++
        if (n > MAX_ENTRIES_IN_OUTPUT_TAR) {
          abort = true
          logger.warn(
            {
              url,
              compileDir,
              method,
            },
            'too many entries in tar-ball from clsi-cache'
          )
        } else if (header.type !== 'file' && header.type !== 'directory') {
          abort = true
          logger.warn(
            {
              url,
              compileDir,
              method,
              entryType: header.type,
            },
            'unexpected entry in tar-ball from clsi-cache'
          )
        }
        return abort
      },
    })
  )
  Metrics.count('clsi_cache_download_entries', n)
  timer.done()
  return !abort
}

module.exports = {
  notifyCLSICacheAboutBuild,
  downloadLatestCompileCache,
  downloadOldCompileCache,
}
