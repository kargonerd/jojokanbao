import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { JSDOM, VirtualConsole } from 'jsdom'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { applyPatch, version } from '../apply.mjs'

const source = file => readFile(new URL(`../patch/${file}`, import.meta.url), 'utf8')
const part = '0123456789abcdef0123456789abcdef' + 'encoded-body-fragment'
const chapterPaths = ['e_0', 'e_1', 'e_3'].map(key => `/web/book/chapter/${key}`)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const toc = [
    {chapterUid: 1, chapterIdx: 1, title: '封面'},
    {chapterUid: 2, chapterIdx: 2, title: '甲'},
    {chapterUid: 3, chapterIdx: 3, title: '乙'},
]

async function setup(t, html = '') {
    const virtualConsole = new VirtualConsole()
    virtualConsole.on('jsdomError', error => { if (!error.message.includes('navigation')) throw error })
    const dom = new JSDOM(html, {url: 'https://weread.qq.com/web/reader/b00bkc0', runScripts: 'outside-only', virtualConsole})
    const w = dom.window
    t.after(async () => {
        w.wrx_weread_auto?.stop()
        w.dispatchEvent(new w.Event('pagehide'))
        await delay(0)
        w.close()
    })
    Object.assign(w, {
        indexedDB: new IDBFactory(), IDBKeyRange, File, Blob,
        wrx_weread_utils: {hash: id => id === '123' ? 'b00b' : `c${id}`},
        wrx_common_utils: {downloadFile: file => { w.download = file }},
        chrome: {runtime: {getURL: file => `https://extension.test/${file}`, onMessage: {addListener: callback => { w.onRuntimeMessage = callback }}}},
    })
    const workerCode = await source('sites/weread/cache-worker.js')
    const workerBlobs = new Map()
    w.workerJobs = []
    w.fetch = async () => new Response(workerCode)
    w.URL.createObjectURL = blob => { const url = `blob:${Math.random()}`; workerBlobs.set(url, blob); return url }
    w.URL.revokeObjectURL = url => workerBlobs.delete(url)
    // Separate JS contexts share fake IndexedDB, just as a same-origin browser
    // worker shares the database without sharing the reader's JS objects.
    w.Worker = class {
        constructor(url) {
            this.context = workerBlobs.get(url).text().then(code => {
                const self = {postMessage: data => queueMicrotask(() => {
                    if (!this.stopped) this.onmessage?.({data: structuredClone(data)})
                })}
                vm.runInNewContext(code, {self, indexedDB: w.indexedDB, IDBKeyRange, Blob})
                return self
            })
        }
        postMessage(data) {
            w.workerJobs.push(structuredClone(data))
            this.context.then(self => self.onmessage({data: structuredClone(data)}))
                .catch(error => { if (!this.stopped) this.onerror?.(error) })
        }
        terminate() { this.stopped = true }
    }
    w.HTMLElement.prototype.getClientRects = () => [{width: 10, height: 10}]
    w.HTMLElement.prototype.scrollIntoView = () => {}
    w.eval(await source('sites/weread/store.js'))
    const store = w.wrx_weread_store
    await store.initBookState('b00b')
    await store.storeBookToc('123', {data: [{updated: toc}]})
    await store.storeBookDetail('123', {data: [{book: {title: '测试书', chapterSize: 3}}]})
    w.wrx_weread_ready = Promise.resolve()
    return {w, store}
}

async function cache(store, cid) {
    await Promise.all(chapterPaths.map(key => store.storeBookChapter('b00b', cid, key, part)))
}

test('only committed, complete target chapters count; invalid responses do not replace good data', async t => {
    const {store} = await setup(t)
    await store.storeBookChapter('b00b', 'c2', chapterPaths[0], part)
    assert.equal(store.getBookState().downloaded, 0)
    await store.storeBookChapter('b00b', 'c2', chapterPaths[2], part)
    await store.storeBookChapter('b00b', 'c2', '/web/book/chapter/e_2', part)
    assert.equal(store.getBookState().downloaded, 0)
    await store.storeBookChapter('b00b', 'c2', '/web/book/chapter/e_2', '')
    assert.equal(store.getChapterError('c2'), undefined)
    await store.storeBookChapter('b00b', 'c2', chapterPaths[1], JSON.stringify({error: 'not authorized'.repeat(4)}))
    assert.equal(store.isChapterComplete('c2'), false)
    await store.storeBookChapter('b00b', 'c2', chapterPaths[1], part)
    assert.equal(store.isChapterComplete('c2'), true)
    await store.storeBookChapter('b00b', 'c2', chapterPaths[1], '<html>failure</html>'.repeat(4))
    assert.equal(store.isChapterComplete('c2'), true)
    await cache(store, 'c999')
    assert.equal(store.getBookState().downloaded, 1)
    assert.equal(store.getBookState().total, 2)
})

test('exports reject missing fragments; wrapped metadata and optional partial covers work', async t => {
    const {w, store} = await setup(t)
    await cache(store, 'c2')
    await store.storeBookChapter('b00b', 'c1', chapterPaths[0], part)
    await assert.rejects(store.exportBookData('b00b'), /1\/2/)
    assert.equal(w.download, undefined)
    await cache(store, 'c3')
    const originalStringify = w.JSON.stringify
    w.JSON.stringify = value => {
        assert.equal(value.chapters, undefined, 'reader must never stringify the entire book')
        return originalStringify(value)
    }
    await store.exportBookData('b00b')
    assert.equal(w.download.name, '测试书.json')
    const exported = JSON.parse(await w.download.text())
    assert.equal(exported.chapters.length, 2)
    assert.equal(exported.bookId, '123')
    assert.equal(exported.toc.length, 3)
})

test('restores legacy/v2 parts and never treats an empty or truncated catalog as full', async t => {
    const {w, store} = await setup(t)
    const db = await new Promise(resolve => {
        const request = w.indexedDB.open('wrx', 3)
        request.onsuccess = () => resolve(request.result)
    })
    t.after(() => db.close())
    await new Promise((resolve, reject) => {
        const tx = db.transaction(['chapters', 'cacheMigrations'], 'readwrite')
        tx.objectStore('chapters').put({bid: 'b00b', chapters: [{cid: 'c2', [chapterPaths[0]]: part, [chapterPaths[1]]: part}]})
        tx.objectStore('cacheMigrations').delete('b00b')
        tx.oncomplete = resolve
        tx.onerror = reject
    })
    await store.storeBookChapter('b00b', 'c2', chapterPaths[2], part)
    await store.initBookState('b00b')
    assert.equal(store.isChapterComplete('c2'), true)
    const jobs = w.workerJobs.length
    await store.initBookState('b00b')
    assert.equal(w.workerJobs.length, jobs, 'subsequent loads must not scan legacy bodies again')
    const legacy = await new Promise(resolve => {
        const request = db.transaction('chapters').objectStore('chapters').get('b00b')
        request.onsuccess = () => resolve(request.result)
    })
    assert.equal(legacy.chapters[0][chapterPaths[0]], part, 'original legacy cache stays intact')
    await cache(store, 'c3')
    await store.storeBookDetail('123', {title: '测试书', chapterSize: 4})
    assert.equal(store.getBookState().tocComplete, false)
    await assert.rejects(store.exportBookData('b00b'), /目录 3\/4/)
    await store.initBookState('different')
    assert.equal(store.getBookState().tocComplete, false)
})

test('catalog remount/search binds by title, not index; duplicate titles stay unbound', async t => {
    const {w, store} = await setup(t)
    await cache(store, 'c3')
    w.document.body.innerHTML = '<div class="readerCatalog"><ul><li>乙</li></ul></div><button id="__wrx_export__"></button>'
    await delay(0)
    assert.equal(w.document.querySelector('li').dataset.cid, 'c3')
    assert.equal(w.document.querySelector('li').dataset.downloaded, '1')
    await store.storeBookToc('123', {data: [{updated: [{chapterUid: 4, chapterIdx: 4, title: '乙'}]}]})
    assert.equal(w.document.querySelector('li').dataset.cid, undefined)
    assert.equal(w.document.querySelector('#__wrx_export__').dataset.complete, '0')
})

test('chapter UID zero is retained and TXT waits for both parts', async t => {
    const {store} = await setup(t)
    await store.storeBookToc('123', {data: [{updated: [{chapterUid: 0, chapterIdx: 4, title: '零'}]}]})
    assert.equal(store.getBookState().total, 3)
    await store.storeBookChapter('b00b', 'c0', '/web/book/chapter/t_0', part)
    assert.equal(store.isChapterComplete('c0'), false)
    await store.storeBookChapter('b00b', 'c0', '/web/book/chapter/t_1', part)
    assert.equal(store.isChapterComplete('c0'), true)
})

test('fetch intercept handles Request/RequestInit without consuming the body or copying unrelated responses', async t => {
    const {w} = await setup(t)
    const messages = []
    const calls = []
    Object.assign(w, {Request, Response})
    w.postMessage = msg => messages.push(msg)
    w.fetch = async (resource, options) => {
        calls.push(resource instanceof Request ? await resource.text() : options?.body)
        return new Response(part)
    }
    w.eval(await source('common/xhr-fetch.js'))
    const url = 'https://weread.qq.com/web/book/chapter/e_0'
    const body = JSON.stringify({b: 'b00b', c: 'c2'})
    const response = await w.fetch(new Request(url, {method: 'POST', body}))
    assert.equal(await response.text(), part)
    await w.fetch(url, {method: 'POST', body})
    await delay(20)
    assert.deepEqual(calls, [body, body])
    assert.equal(messages.length, 2)
    assert.equal(messages[0].request, body)
    assert.equal(messages[1].request, body)
    await w.fetch('https://weread.qq.com/unrelated')
    await delay(10)
    assert.equal(messages.length, 2)
})

test('content bridge accepts its own fetch body strings and rejects other windows', async t => {
    const {w, store} = await setup(t)
    w.eval(await source('sites/weread/content.js'))
    await w.wrx_weread_ready
    for (const pathname of chapterPaths) {
        const data = {from: 'wrx', site: w.location.origin, pathname, request: JSON.stringify({b: 'b00b', c: 'c2'}), response: part}
        w.dispatchEvent(new w.MessageEvent('message', {data, origin: w.location.origin, source: null}))
    }
    await delay(10)
    assert.equal(store.isChapterComplete('c2'), false)
    for (const pathname of chapterPaths) {
        const data = {from: 'wrx', site: w.location.origin, pathname, request: JSON.stringify({b: 'b00b', c: 'c2'}), response: part}
        w.dispatchEvent(new w.MessageEvent('message', {data, origin: w.location.origin, source: w}))
    }
    await delay(30)
    assert.equal(store.isChapterComplete('c2'), true)
})

test('batch skips complete chapters and waits for its target despite unrelated prefetch', async t => {
    const {w, store} = await setup(t, '<div class="readerCatalog"><ul><li>甲</li><li>乙</li></ul></div><button class="readerFooter_button">写点评</button>')
    await store.updatePageCatalog()
    let clicked = 0
    let footerClicked = false
    w.document.querySelector('button').onclick = () => { footerClicked = true }
    w.document.querySelector('li').onclick = async () => {
        clicked++
        await cache(store, 'c3') // Reader prefetch arrives before requested c2.
        await store.storeBookChapter('b00b', 'c2', chapterPaths[0], part)
        setTimeout(() => cache(store, 'c2'), 180)
    }
    w.eval(await source('sites/weread/auto.js'))
    const running = w.wrx_weread_auto.start({interval: 0.1})
    await delay(100)
    assert.equal(w.document.querySelector('#__wrx_auto_read__').textContent.includes('完成'), false)
    await running
    assert.equal(clicked, 1)
    assert.equal(footerClicked, false)
    assert.match(w.document.querySelector('#__wrx_auto_read__').textContent, /2\/2/)
})

test('stop invalidates pending waits so old runs cannot continue or navigate', async t => {
    const {w, store} = await setup(t, '<div class="readerCatalog"><ul><li>甲</li><li>乙</li></ul></div>')
    await store.updatePageCatalog()
    w.eval(await source('sites/weread/auto.js'))
    const running = w.wrx_weread_auto.start()
    await delay(30)
    w.wrx_weread_auto.stop()
    await running
    assert.equal(w.sessionStorage.getItem('wrx:run:b00b'), null)
    assert.match(w.document.querySelector('#__wrx_auto_read__').textContent, /已停止/)
})

test('resumes a chapter URL reload and ends when the resumed target is fully cached', async t => {
    const {w, store} = await setup(t)
    await cache(store, 'c2')
    await cache(store, 'c3')
    w.sessionStorage.setItem('wrx:run:b00b', JSON.stringify({args: {}, target: 'c3', at: Date.now()}))
    w.eval(await source('sites/weread/auto.js'))
    await delay(10)
    assert.match(w.document.querySelector('#__wrx_auto_read__').textContent, /翻章完成/)
    assert.equal(w.sessionStorage.getItem('wrx:run:b00b'), null)
})

test('large runs recycle the reader after eight loaded chapters and resume at the next missing CID', async t => {
    const {w, store} = await setup(t)
    const rows = Array.from({length: 10}, (_, index) => ({chapterUid: index + 2, chapterIdx: index + 2, title: `章节${index + 2}`}))
    await store.storeBookToc('123', {data: [{updated: rows}]})
    w.document.body.innerHTML = `<div class="readerCatalog"><ul>${rows.map(row => `<li>${row.title}</li>`).join('')}</ul></div>`
    await store.updatePageCatalog()
    let clicks = 0
    for (const li of w.document.querySelectorAll('li')) li.onclick = () => { clicks++; cache(store, li.dataset.cid) }
    w.eval(await source('sites/weread/auto.js'))
    await w.wrx_weread_auto.start({interval: 0.1})
    assert.equal(clicks, 8)
    assert.equal(JSON.parse(w.sessionStorage.getItem('wrx:run:b00b')).target, 'c10')
    assert.equal(store.getBookState().downloaded, 8)
})

test('the resumed chapter counts towards the page limit, and heap pressure recycles early', async t => {
    for (const highHeap of [false, true]) {
        const {w, store} = await setup(t)
        const rows = Array.from({length: 10}, (_, index) => ({chapterUid: index + 2, chapterIdx: index + 2, title: `章节${index + 2}`}))
        await store.storeBookToc('123', {data: [{updated: rows}]})
        w.document.body.innerHTML = `<div class="readerCatalog"><ul>${rows.map(row => `<li>${row.title}</li>`).join('')}</ul></div>`
        await store.updatePageCatalog()
        await cache(store, 'c2')
        if (highHeap) Object.defineProperty(w.performance, 'memory', {value: {usedJSHeapSize: 400 * 1024 * 1024, jsHeapSizeLimit: 2 ** 30}})
        let clicks = 0
        for (const li of w.document.querySelectorAll('li')) li.onclick = () => { clicks++; cache(store, li.dataset.cid) }
        w.eval(await source('sites/weread/auto.js'))
        await w.wrx_weread_auto.start({interval: 0.1}, {target: 'c2'})
        assert.equal(clicks, highHeap ? 0 : 7)
        assert.equal(JSON.parse(w.sessionStorage.getItem('wrx:run:b00b')).target, highHeap ? 'c3' : 'c10')
    }
})

test('a blocked worker stops export without falling back to loading the entire book', async t => {
    const {w, store} = await setup(t)
    await cache(store, 'c2')
    await cache(store, 'c3')
    w.Worker = class { constructor() { throw new Error('Worker blocked') } }
    await assert.rejects(store.exportBookData('b00b'), /Worker blocked/)
    assert.equal(w.download, undefined)
    assert.equal(store.getBookState().downloaded, 2)
})

test('installer backs up exact files, injects MAIN early and preserves permissions on repeated application', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wrx-patch-test-'))
    const files = ['common/xhr-fetch.js', 'sites/weread/store.js', 'sites/weread/content.js', 'sites/weread/auto.js']
    for (const file of files) {
        await mkdir(path.dirname(path.join(directory, file)), {recursive: true})
        await writeFile(path.join(directory, file), 'original')
    }
    const manifest = {manifest_version: 3, version: '0.1.0.15', permissions: ['declarativeNetRequest'],
        content_scripts: [{matches: ['https://*.weread.qq.com/web/reader/*'], world: 'ISOLATED', js: ['common/inject.js', 'sites/weread/store.js']}]}
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest))
    const result = await applyPatch(directory)
    assert.equal(await readFile(path.join(result.backup, files[0]), 'utf8'), 'original')
    await applyPatch(directory)
    const updated = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
    assert.equal(updated.version, version)
    assert.deepEqual(updated.permissions, manifest.permissions)
    assert.equal(updated.content_scripts.filter(script => script.world === 'MAIN').length, 1)
    assert.equal(updated.content_scripts[0].run_at, 'document_start')
    assert.equal(updated.content_scripts[1].js.includes('common/inject.js'), false)
    assert.equal(updated.web_accessible_resources.filter(group => group.resources.includes('sites/weread/cache-worker.js')).length, 1)
    assert.equal(await readFile(path.join(directory, 'sites/weread/cache-worker.js'), 'utf8'), await source('sites/weread/cache-worker.js'))
})
