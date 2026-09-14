(() => {
    const store = window.wrx_weread_store
    const bid = location.pathname.split('/').pop().split('k')[0]
    const resumeKey = `wrx:run:${bid}`
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    let generation = 0
    let running = false
    let status
    let loadedOnPage = 0
    const chaptersPerPage = 8

    function bookComplete(state) {
        return state.tocComplete && state.total > 0 && state.downloaded === state.total
    }
    function setStatus(text) {
        if (status) {
            const complete = bookComplete(store.getBookState())
            status.textContent = text
            status.dataset.complete = complete ? '1' : '0'
            status.style.background = running || complete ? '#16865c' : '#e9e9e9'
            status.style.color = running || complete ? 'white' : '#a32727'
        }
    }
    function stop(message = '快速翻章: 已停止') {
        generation++
        running = false
        sessionStorage.removeItem(resumeKey)
        setStatus(message)
    }
    function visible(element) {
        return element && !element.disabled && element.getAttribute('aria-disabled') !== 'true' &&
            element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
    }
    function currentCid() { return location.pathname.split('k')[1] || '' }
    function catalogTarget(cid) {
        for (const li of document.querySelectorAll('.readerCatalog ul > li')) {
            if (li.dataset.cid !== cid || !visible(li)) continue
            const inner = li.querySelector('.readerCatalog_list_item_inner, a, button') || li
            if (visible(inner)) return inner
        }
    }
    function saveResume(args, target) {
        sessionStorage.setItem(resumeKey, JSON.stringify({args, target, at: Date.now()}))
    }
    function navigate(args, cid) {
        saveResume(args, cid)
        // Replacing avoids growing history/BFCache for hundreds of chapter URLs.
        location.replace(`${location.origin}/web/reader/${bid}k${cid}`)
    }
    function shouldRecyclePage() {
        const heap = performance.memory
        return loadedOnPage >= chaptersPerPage || (loadedOnPage > 0 && heap &&
            heap.usedJSHeapSize > Math.min(384 * 1024 * 1024, heap.jsHeapSizeLimit * 0.4))
    }
    async function waitForChapter(cid, id, timeout) {
        const deadline = Date.now() + timeout
        while (id === generation && running && Date.now() < deadline) {
            if (store.isChapterComplete(cid)) return true
            const error = store.getChapterError(cid)
            if (error) throw new Error(error)
            await sleep(80)
        }
        return store.isChapterComplete(cid)
    }
    async function run(args, id, resume) {
        await window.wrx_weread_ready
        if (id !== generation) return
        const deadline = Date.now() + 15000
        while (!store.getBookState().tocComplete && id === generation && Date.now() < deadline) {
            setStatus('快速翻章: 等待完整目录…')
            await sleep(150)
        }
        if (id !== generation) return
        if (!store.getBookState().tocComplete) throw new Error('目录未加载完整，请打开目录或刷新后重试')
        if (resume?.target) {
            if (!(await waitForChapter(resume.target, id, 15000))) {
                if (id !== generation) return
                throw new Error('此章正文未保存完整，请检查登录、阅读权限或网络后重试')
            }
            loadedOnPage++
        }
        while (id === generation && running) {
            const state = store.getBookState()
            if (!state.missing.length) {
                stop(`翻章完成，已缓存 ${state.downloaded}/${state.total}`)
                return
            }
            const target = args.direction === 'prev' ? state.missing.at(-1) : state.missing[0]
            setStatus(`已缓存 ${state.downloaded}/${state.total}，正在补全：${target.title}`)
            if (shouldRecyclePage()) { navigate(args, target.cid); return }
            if (target.cid === currentCid()) {
                // The visible chapter may already be in flight. Never leave on its first part.
                if (await waitForChapter(target.cid, id, 15000)) { loadedOnPage++; continue }
            } else {
                const item = catalogTarget(target.cid)
                if (item) {
                    item.scrollIntoView({block: 'nearest', behavior: 'auto'})
                    item.click()
                    if (await waitForChapter(target.cid, id, 12000)) {
                        loadedOnPage++
                        await sleep(args.interval * 1000)
                        continue
                    }
                }
            }
            if (id !== generation) return
            // Hidden/unmounted catalog, duplicate titles, or ignored DOM clicks: use the
            // same reader URL as a normal chapter link, then resume from IndexedDB.
            navigate(args, target.cid)
            return
        }
    }
    async function start(options = {}, resume) {
        if (running) return
        const interval = Number(options.interval)
        const args = {direction: options.direction === 'prev' ? 'prev' : 'next',
            interval: Number.isFinite(interval) ? Math.min(30, Math.max(0.1, interval)) : 0.25}
        running = true
        const id = ++generation
        setStatus('快速翻章: 检查缓存…')
        try { await run(args, id, resume) }
        catch (error) {
            console.warn('[wrx]', error)
            if (id === generation) stop(`快速翻章: ${error.message}`)
        }
    }
    function mount() {
        status = document.createElement('button')
        status.id = '__wrx_auto_read__'
        status.title = '补全未缓存章节；再次点击停止'
        Object.assign(status.style, {
            position: 'fixed', top: '20px', right: '20px', zIndex: '9999', maxWidth: '460px',
            padding: '.5em .75em', cursor: 'pointer', color: '#a32727', fontSize: '16px', fontWeight: 'bold',
        })
        status.addEventListener('click', () => running ? stop() : start())
        document.body.appendChild(status)
        setStatus('快速翻章: 关')
        window.addEventListener('wrx-cache-progress', event => {
            if (running) setStatus(event.detail)
        })
        const updateCompletion = () => {
            if (running) return
            const state = store.getBookState()
            setStatus(bookComplete(state) ? `翻章完成，已缓存 ${state.downloaded}/${state.total}`
                : status.dataset.complete === '1' ? '快速翻章: 关' : status.textContent)
        }
        window.addEventListener('wrx-cache-updated', updateCompletion)
        window.wrx_weread_ready?.then(updateCompletion).catch(() => {})
        const saved = sessionStorage.getItem(resumeKey)
        sessionStorage.removeItem(resumeKey)
        try {
            const resume = JSON.parse(saved)
            if (resume && Date.now() - resume.at < 120000) start(resume.args, resume)
        } catch { /* Discard invalid or expired resume state. */ }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true})
    else mount()
    chrome.runtime.onMessage.addListener(message => {
        if (message.type === 'start') start(message.args)
        if (message.type === 'stop') stop()
    })
    // Exposed only in the extension's isolated world for regression tests/diagnostics.
    window.wrx_weread_auto = {start, stop}
})()
