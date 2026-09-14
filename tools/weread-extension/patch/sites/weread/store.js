(() => {
    const groups = [['e_0', 'e_1', 'e_3'], ['t_0', 't_1']]
        .map(group => group.map(part => `/web/book/chapter/${part}`))
    const complete = chapter => groups.some(group => group.every(key => validPart(chapter?.[key])))
    // Error JSON/HTML and short responses must never turn a chapter green.
    function validPart(value) {
        return typeof value === 'string' && value.length > 32 && !/^[\s]*[<{[]/.test(value)
    }
    let databasePromise
    let activeBid
    let toc = []
    let expectedEntries = []
    let titles = new Map()
    let declaredCount = 0
    const cached = new Set()
    const failures = new Map()
    let observer
    let workerSource
    const migrations = new Map()
    window.addEventListener('pagehide', () => { observer?.disconnect(); observer = undefined })

    function openDatabase() {
        if (databasePromise) return databasePromise
        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open('wrx', 3)
            request.onupgradeneeded = () => {
                const db = request.result
                for (const name of ['chapters', 'tocs', 'details']) {
                    if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, {keyPath: 'bid'})
                }
                if (!db.objectStoreNames.contains('chapterItems')) {
                    db.createObjectStore('chapterItems', {keyPath: ['bid', 'cid']})
                        .createIndex('bid', 'bid', {unique: false})
                }
                if (!db.objectStoreNames.contains('chapterStatus')) {
                    db.createObjectStore('chapterStatus', {keyPath: ['bid', 'cid']})
                        .createIndex('bid', 'bid', {unique: false})
                }
                if (!db.objectStoreNames.contains('cacheMigrations')) db.createObjectStore('cacheMigrations', {keyPath: 'bid'})
            }
            request.onsuccess = () => {
                const db = request.result
                db.onversionchange = () => { db.close(); databasePromise = undefined }
                resolve(db)
            }
            request.onerror = () => { databasePromise = undefined; reject(request.error) }
            request.onblocked = () => {
                console.warn('[wrx] 请关闭其他微信读书标签页后刷新，数据库升级正在等待')
            }
        })
        return databasePromise
    }

    function done(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = resolve
            tx.onerror = () => reject(tx.error)
            tx.onabort = () => reject(tx.error || new Error('存储事务已中止'))
        })
    }

    async function get(name, bid) {
        const db = await openDatabase()
        return new Promise((resolve, reject) => {
            const request = db.transaction(name).objectStore(name).get(bid)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
    }

    function metadata(detail) {
        return detail?.data?.[0]?.book || detail?.data?.[0] || detail?.book || detail || {}
    }

    function entries(source = toc) {
        const seen = new Set()
        return source.flatMap((entry, index) => {
            if (entry.chapterUid == null || (index === 0 && Math.max(1, Number(entry.level) || 1) === 1 && /^(封面|cover)$/i.test(entry.title?.trim()))) return []
            const cid = window.wrx_weread_utils.hash(entry.chapterUid)
            if (seen.has(cid)) return []
            seen.add(cid)
            return [{...entry, cid}]
        })
    }

    function getBookState() {
        const expected = expectedEntries
        return {
            bid: activeBid, total: expected.length,
            downloaded: expected.filter(entry => cached.has(entry.cid)).length,
            missing: expected.filter(entry => !cached.has(entry.cid)),
            tocComplete: toc.length > 0 && toc.length >= declaredCount,
        }
    }

    function notify() {
        updateCatalogMarkers()
        window.dispatchEvent(new Event('wrx-cache-updated'))
    }

    async function storeBookChapter(bid, cid, pathname, content) {
        if (!bid || !cid || !groups.flat().concat('/web/book/chapter/e_2').includes(pathname)) return
        if (!validPart(content)) {
            if (pathname !== '/web/book/chapter/e_2' && bid === activeBid && !cached.has(cid)) {
                failures.set(cid, '章节响应无效，请检查登录、阅读权限或网络')
            }
            return
        }
        const db = await openDatabase()
        const tx = db.transaction(['chapterItems', 'chapterStatus'], 'readwrite')
        const finished = done(tx)
        const store = tx.objectStore('chapterItems')
        const request = store.get([bid, cid])
        let chapter
        request.onsuccess = () => {
            chapter = request.result || {bid, cid}
            chapter[pathname] = content
            store.put(chapter)
            tx.objectStore('chapterStatus').put({bid, cid, complete: complete(chapter)})
        }
        await finished
        if (bid === activeBid && complete(chapter)) {
            cached.add(cid)
            failures.delete(cid)
            notify()
        }
    }

    async function storeBookToc(bookId, response) {
        const updates = response?.data?.[0]?.updated
        if (!Array.isArray(updates) || !updates.length) return
        const bid = window.wrx_weread_utils.hash(bookId)
        const db = await openDatabase()
        const tx = db.transaction('tocs', 'readwrite')
        const finished = done(tx)
        const store = tx.objectStore('tocs')
        const request = store.get(bid)
        let record
        request.onsuccess = () => {
            // chapterInfos may return an incremental update; preserve cached chapters.
            const byUid = new Map((request.result?.toc || []).map(entry => [entry.chapterUid, entry]))
            for (const entry of updates) byUid.set(entry.chapterUid, entry)
            for (const uid of response?.data?.[0]?.removed || []) byUid.delete(uid)
            record = {bid, bookId, toc: [...byUid.values()].sort((a, b) => a.chapterIdx - b.chapterIdx)}
            store.put(record)
        }
        await finished
        if (bid === activeBid) { setToc(record.toc); notify() }
    }

    async function storeBookDetail(bookId, detail) {
        if (!bookId || !metadata(detail).title) return
        const bid = window.wrx_weread_utils.hash(bookId)
        const db = await openDatabase()
        const tx = db.transaction('details', 'readwrite')
        const finished = done(tx)
        tx.objectStore('details').put({bid, bookId, detail})
        await finished
        if (bid === activeBid) {
            declaredCount = Math.max(0, Number(metadata(detail).chapterSize) || 0, Number(metadata(detail).lastChapterIdx) || 0)
            notify()
        }
    }

    function titleKey(title = '') {
        return title.replace(/当前读到\s*\d+%.*$/, '').replace(/^第\d+章\s/, '')
            .replace(/[\s\u00a0']/g, '').replace(/\[\d+]/g, '')
    }

    function setToc(value) {
        toc = value
        expectedEntries = entries()
        titles = new Map()
        const flat = toc.flatMap(entry => [entry, ...(entry.anchors || []).map(anchor => ({...entry, ...anchor}))])
        for (const entry of flat) {
            const key = titleKey(entry.title)
            const ids = titles.get(key) || new Set()
            ids.add(window.wrx_weread_utils.hash(entry.chapterUid))
            titles.set(key, ids)
        }
    }

    function updateCatalogMarkers() {
        // Do not bind by index: search results, hidden cover and virtual lists change it.
        for (const li of document.querySelectorAll('.readerCatalog ul > li')) {
            const link = li.querySelector('a[href*="/web/reader/"]')
            const linkedCid = link?.getAttribute('href')?.split('k')[1]?.split(/[?#]/)[0]
            const ids = titles.get(titleKey(li.textContent))
            const cid = linkedCid || (ids?.size === 1 ? [...ids][0] : '')
            if (cid) li.dataset.cid = cid
            else delete li.dataset.cid
            li.dataset.downloaded = cid && cached.has(cid) ? '1' : '0'
        }
        const state = getBookState()
        const full = state.tocComplete && state.total > 0 && state.downloaded === state.total
        const button = document.querySelector('#__wrx_export__')
        if (button) {
            button.textContent = `导出本书数据${full ? ' (全)' : ''}`
            button.dataset.complete = full ? '1' : '0'
            button.style.background = full ? '#16865c' : '#e9e9e9'
            button.style.color = full ? 'white' : '#a32727'
        }
    }

    async function runWorker(job) {
        await openDatabase()
        workerSource ??= fetch(chrome.runtime.getURL('sites/weread/cache-worker.js'))
            .then(response => { if (!response.ok) throw new Error('无法加载缓存工作线程'); return response.text() })
            .catch(error => { workerSource = undefined; throw error })
        const source = await workerSource
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}))
            let worker
            const finish = (error, data) => {
                worker?.terminate()
                URL.revokeObjectURL(url)
                if (error) reject(error)
                else resolve(data)
            }
            try {
                worker = new Worker(url)
                worker.onmessage = ({data}) => {
                    if (data.progress) window.dispatchEvent(new CustomEvent('wrx-cache-progress', {detail: data.progress}))
                    if (data.error) finish(new Error(data.error))
                    else if (data.done) finish(null, data)
                }
                worker.onerror = () => finish(new Error('缓存工作线程无法运行，请重新加载扩展并刷新；已保存数据保留'))
                worker.postMessage(job)
            } catch (error) { finish(error) }
        })
    }

    async function ensureMigrated(bid) {
        if ((await get('cacheMigrations', bid))?.complete) return
        if (!migrations.has(bid)) {
            migrations.set(bid, runWorker({type: 'migrate', bid}).finally(() => migrations.delete(bid)))
        }
        await migrations.get(bid)
    }

    async function readStatus(bid, visit) {
        const db = await openDatabase()
        const tx = db.transaction('chapterStatus')
        const finished = done(tx)
        const cursor = tx.objectStore('chapterStatus').index('bid').openCursor(IDBKeyRange.only(bid))
        cursor.onsuccess = () => {
            if (!cursor.result) return
            visit(cursor.result.value)
            cursor.result.continue()
        }
        await finished
    }

    async function initBookState(bid) {
        activeBid = bid
        cached.clear()
        failures.clear()
        const [tocRecord, detail] = await Promise.all([get('tocs', bid), get('details', bid)])
        setToc(tocRecord?.toc || [])
        const meta = metadata(detail?.detail)
        declaredCount = Math.max(0, Number(meta.chapterSize) || 0, Number(meta.lastChapterIdx) || 0)
        await ensureMigrated(bid)
        await readStatus(bid, row => { if (row.complete) cached.add(row.cid) })
        if (!observer) {
            let scheduled = false
            observer = new MutationObserver(records => {
                if (!records.some(record => record.target.closest?.('.readerCatalog') || [...record.addedNodes, ...record.removedNodes]
                    .some(node => node.nodeType === 1 && (node.matches?.('.readerCatalog, .readerCatalog ul, .readerCatalog li') ||
                        node.querySelector?.('.readerCatalog'))))) return
                if (scheduled) return
                scheduled = true
                queueMicrotask(() => { scheduled = false; updateCatalogMarkers() })
            })
            observer.observe(document.body, {childList: true, subtree: true})
        }
        notify()
    }

    async function exportBookData(bid) {
        await ensureMigrated(bid)
        const [tocRecord, detailRecord] = await Promise.all([get('tocs', bid), get('details', bid)])
        if (!tocRecord?.toc?.length || !detailRecord?.detail) throw new Error('数据不完整，缺少目录或元数据，请刷新书页')
        const expected = entries(tocRecord.toc)
        const completeCids = new Set()
        await readStatus(bid, row => { if (row.complete) completeCids.add(row.cid) })
        const missing = expected.filter(entry => !completeCids.has(entry.cid))
        const meta = metadata(detailRecord.detail)
        const declared = Math.max(Number(meta.chapterSize) || 0, Number(meta.lastChapterIdx) || 0)
        if (!expected.length || missing.length || tocRecord.toc.length < declared) {
            throw new Error(`数据不完整：${missing.length}/${expected.length} 章缺少正文分片，目录 ${tocRecord.toc.length}/${Math.max(declared, tocRecord.toc.length)}。请先补全后导出。`)
        }
        const book = {
            bid, bookId: tocRecord.bookId, toc: tocRecord.toc, meta: detailRecord.detail,
            site: location.origin, date: Date.now(),
        }
        const name = String(meta.title || tocRecord.bookId).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        const {blob} = await runWorker({type: 'export', bid, header: book, cids: expected.map(entry => entry.cid)})
        window.wrx_common_utils.downloadFile(new File([blob], `${name}.json`, {type: 'application/json'}))
    }

    window.wrx_weread_store = {
        storeBookChapter, storeBookToc, storeBookDetail, initBookState, exportBookData,
        getBookState, isChapterComplete: cid => cached.has(cid),
        getChapterError: cid => failures.get(cid), updatePageCatalog: async () => updateCatalogMarkers(),
    }
})()
