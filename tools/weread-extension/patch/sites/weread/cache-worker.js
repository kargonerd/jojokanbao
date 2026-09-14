// Runs in a page-origin Blob Worker. Large legacy records and chapter JSON
// strings stay in this short-lived worker, never in the reader's main heap.
(() => {
    const required = [['e_0', 'e_1', 'e_3'], ['t_0', 't_1']]
        .map(group => group.map(part => `/web/book/chapter/${part}`))
    const valid = value => typeof value === 'string' && value.length > 32 && !/^\s*[<{[]/.test(value)
    const complete = chapter => required.some(group => group.every(key => valid(chapter?.[key])))
    const done = tx => new Promise((resolve, reject) => {
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error || new Error('缓存事务已中止'))
    })
    const get = (db, store, key) => new Promise((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).get(key)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
    async function migrate(db, bid) {
        if ((await get(db, 'cacheMigrations', bid))?.complete) return
        // IndexedDB cannot project fields out of an old monolithic value. Read
        // it once here, preserve it on disk, and migrate to individual records.
        const legacy = await get(db, 'chapters', bid)
        const chapters = legacy?.chapters || []
        for (let index = 0; index < chapters.length; index++) {
            const old = chapters[index]
            if (!old?.cid) continue
            const tx = db.transaction(['chapterItems', 'chapterStatus'], 'readwrite')
            const finished = done(tx)
            const store = tx.objectStore('chapterItems')
            const request = store.get([bid, old.cid])
            request.onsuccess = () => {
                const merged = {...old, ...request.result, bid}
                store.put(merged)
                tx.objectStore('chapterStatus').put({bid, cid: merged.cid, complete: complete(merged)})
            }
            await finished
            // Release migrated strings rather than retaining the full book
            // throughout the remaining scan. The stored legacy value is intact.
            chapters[index] = null
            if (index % 32 === 0) self.postMessage({progress: `整理旧缓存 ${index + 1}/${chapters.length}`})
        }
        // Older v2 rows may have no status. This cursor reads one chapter at a
        // time; subsequent page loads will read only the small status records.
        const tx = db.transaction(['chapterItems', 'chapterStatus', 'cacheMigrations'], 'readwrite')
        const finished = done(tx)
        const cursor = tx.objectStore('chapterItems').index('bid').openCursor(IDBKeyRange.only(bid))
        cursor.onsuccess = () => {
            const row = cursor.result
            if (row) {
                tx.objectStore('chapterStatus').put({bid, cid: row.value.cid, complete: complete(row.value)})
                row.continue()
            } else tx.objectStore('cacheMigrations').put({bid, complete: true})
        }
        await finished
    }
    async function exportBook(db, {bid, header, cids}) {
        // Keep only Blob handles for completed chapters. No chapters array and
        // no JSON.stringify(book) that duplicates the entire book in JS memory.
        const head = JSON.stringify(header)
        const chunks = [new Blob([head.slice(0, -1), ',"chapters":['])]
        for (let index = 0; index < cids.length; index++) {
            const chapter = await get(db, 'chapterItems', [bid, cids[index]])
            if (!complete(chapter)) throw new Error(`数据不完整：第 ${index + 1}/${cids.length} 章缺少正文分片，请先补全`)
            const {bid: unused, ...record} = chapter
            chunks.push(new Blob([index ? ',' : '', JSON.stringify(record)]))
            if (index % 32 === 0) self.postMessage({progress: `导出 ${index + 1}/${cids.length} 章`})
        }
        chunks.push(new Blob([']}']))
        return new Blob(chunks, {type: 'application/json'})
    }
    self.onmessage = async ({data}) => {
        let db
        try {
            // Schema creation belongs to store.js, before any worker is started.
            db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('wrx', 3)
                request.onsuccess = () => resolve(request.result)
                request.onerror = () => reject(request.error)
            })
            if (data.type === 'migrate') await migrate(db, data.bid)
            else if (data.type === 'export') {
                await migrate(db, data.bid)
                const blob = await exportBook(db, data)
                self.postMessage({done: true, blob})
                return
            } else throw new Error('未知缓存任务')
            self.postMessage({done: true})
        } catch (error) {
            self.postMessage({error: error?.message || String(error)})
        } finally { db?.close() }
    }
})()
