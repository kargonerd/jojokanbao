(() => {
    const bid = location.pathname.split('/').pop().split('k')[0]
    const store = window.wrx_weread_store
    let ready
    async function initialize() {
        const button = document.createElement('button')
        button.id = '__wrx_export__'
        button.textContent = '导出本书数据'
        Object.assign(button.style, {
            position: 'fixed', top: '80px', right: '20px', zIndex: '9999',
            fontSize: '16px', fontWeight: 'bold', padding: '.5em .75em', color: '#a32727',
            background: '#e9e9e9', cursor: 'pointer',
        })
        button.addEventListener('click', async () => {
            button.disabled = true
            window.wrx_weread_auto?.stop()
            try { await ready; await store.exportBookData(bid) }
            catch (error) { alert(error.message); console.warn('[wrx]', error) }
            finally { button.disabled = false; await store.updatePageCatalog() }
        })
        document.body.appendChild(button)
        window.addEventListener('wrx-cache-progress', event => {
            if (button.disabled) button.textContent = event.detail
        })
        await store.initBookState(bid)
    }
    ready = new Promise((resolve, reject) => {
        const boot = () => initialize().then(resolve, reject)
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once: true})
        else boot()
    })
    window.wrx_weread_ready = ready
    ready.catch(error => console.warn('[wrx] 初始化失败:', error))

    window.addEventListener('message', async event => {
        const {data} = event
        if (event.source !== window || event.origin !== location.origin || data?.from !== 'wrx' || data.site !== location.origin) return
        try {
            const {pathname, request, response, search} = data
            const body = typeof request === 'string' ? JSON.parse(request || '{}') : request || {}
            if (/^\/web\/book\/chapter\/(e_[0-3]|t_[01])$/.test(pathname)) {
                if (body.b !== bid) return
                await store.storeBookChapter(body.b, body.c, pathname, response)
            } else if (pathname === '/web/book/info' || pathname === '/web/book/publicinfos') {
                const bookId = pathname.endsWith('/info') ? new URLSearchParams(search).get('bookId') : body.bookIds?.[0]
                if (window.wrx_weread_utils.hash(bookId) === bid) await store.storeBookDetail(bookId, JSON.parse(response))
            } else if (['/web/book/chapterInfos', '/web/book/publicchapterInfos'].includes(pathname)) {
                const bookId = body.bookIds?.[0]
                if (window.wrx_weread_utils.hash(bookId) === bid) await store.storeBookToc(bookId, JSON.parse(response))
            }
        } catch (error) { console.warn('[wrx] 保存响应失败:', error) }
    })
})()
