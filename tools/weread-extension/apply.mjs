import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const version = '0.1.0.18'
const patchDirectory = fileURLToPath(new URL('./patch/', import.meta.url))
const workerFile = 'sites/weread/cache-worker.js'
const files = ['common/xhr-fetch.js', 'sites/weread/store.js', 'sites/weread/content.js', 'sites/weread/auto.js', workerFile]

export async function applyPatch(directory) {
    const target = await realpath(directory)
    const manifestPath = path.join(target, 'manifest.json')
    const originalManifest = await readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(originalManifest)
    const reader = manifest.content_scripts?.find(script => script.matches?.includes('https://*.weread.qq.com/web/reader/*') && script.world === 'ISOLATED')
    if (manifest.manifest_version !== 3 || !reader?.js?.includes('sites/weread/store.js')) {
        throw new Error('目标目录不是受支持的 WRX MV3 插件')
    }
    // Read/check every input before touching the installed extension. Retain its
    // bundled libraries, overrides, permissions and all browser-side book data.
    const changes = await Promise.all(files.map(async file => {
        const destination = path.join(target, file)
        const resolved = await realpath(destination).catch(error => {
            if (file === workerFile && error.code === 'ENOENT') return null
            throw error
        })
        const parent = await realpath(path.dirname(destination))
        if (!parent.startsWith(target + path.sep) || (resolved && (!resolved.startsWith(target + path.sep) || !(await stat(resolved)).isFile()))) {
            throw new Error(`不安全的目标路径: ${file}`)
        }
        return {file, destination, exists: Boolean(resolved), content: await readFile(path.join(patchDirectory, file))}
    }))
    const backup = `${target}.backup-${manifest.version}-${Date.now()}`
    await mkdir(backup)
    await writeFile(path.join(backup, 'manifest.json'), originalManifest)
    for (const {file, destination, exists} of changes) {
        if (!exists) continue
        await mkdir(path.dirname(path.join(backup, file)), {recursive: true})
        await copyFile(destination, path.join(backup, file))
    }
    manifest.web_accessible_resources ??= []
    if (!manifest.web_accessible_resources.some(group => group.resources?.includes(workerFile))) {
        manifest.web_accessible_resources.push({matches: ['https://*.weread.qq.com/*'], resources: [workerFile]})
    }
    reader.js = reader.js.filter(file => file !== 'common/inject.js')
    if (!manifest.content_scripts.some(script => script.world === 'MAIN' && script.js?.includes('common/xhr-fetch.js'))) {
        manifest.content_scripts.unshift({
            matches: reader.matches, js: ['common/xhr-fetch.js'], run_at: 'document_start', world: 'MAIN', all_frames: false,
        })
    }
    manifest.version = version
    for (const {destination, content} of changes) await writeFile(destination, content)
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    return {target, backup, version}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 3) throw new Error('Usage: node tools/weread-extension/apply.mjs <WRX 插件目录>')
    console.log(JSON.stringify(await applyPatch(process.argv[2]), null, 2))
}
