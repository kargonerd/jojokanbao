(() => {
    if (window.__wrxNetworkHook) return
    window.__wrxNetworkHook = true
    const paths = new Set([
        '/web/book/chapter/e_0', '/web/book/chapter/e_1', '/web/book/chapter/e_2', '/web/book/chapter/e_3',
        '/web/book/chapter/t_0', '/web/book/chapter/t_1', '/web/book/info', '/web/book/publicinfos',
        '/web/book/chapterInfos', '/web/book/publicchapterInfos',
    ])
    function target(resource) {
        try {
            const url = new URL(resource instanceof Request ? resource.url : String(resource), location.href)
            if ((url.origin === 'https://weread.qq.com' && paths.has(url.pathname)) ||
                (url.origin === 'https://www.zhihu.com' && /^\/api\/v3\/books\/[a-z0-9]+(?:\/chapters(?:\/[a-z0-9]+\/download)?)?$/i.test(url.pathname))) return url
        } catch { /* A malformed URL is handled by the original browser method. */ }
    }
    function emit(url, request, response) {
        window.postMessage({
            from: 'wrx', site: url.origin, api: url.pathname, pathname: url.pathname,
            search: url.search, url: url.href, request, response,
        }, location.origin)
    }
    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    const urls = new WeakMap()
    XMLHttpRequest.prototype.open = function (method, url) {
        urls.set(this, target(url))
        return originalOpen.apply(this, arguments)
    }
    XMLHttpRequest.prototype.send = function (body) {
        const url = urls.get(this)
        if (url) this.addEventListener('load', () => {
            if (this.status < 200 || this.status >= 300) return
            const response = typeof this.response === 'string' ? this.response : JSON.stringify(this.response)
            emit(url, typeof body === 'string' ? body : body?.toString(), response)
        }, {once: true})
        return originalSend.apply(this, arguments)
    }
    const originalFetch = window.fetch
    window.fetch = function (resource, options) {
        const url = target(resource)
        if (!url) return originalFetch.apply(this, arguments)
        // Clone before native fetch consumes Request.body, and send the body string,
        // not Request/RequestInit objects (which cannot be parsed by the receiver).
        let body
        try {
            body = options?.body != null ? Promise.resolve(String(options.body))
                : resource instanceof Request ? resource.clone().text() : Promise.resolve('')
        } catch { body = Promise.resolve('') }
        return originalFetch.apply(this, arguments).then(response => {
            if (response.ok) Promise.all([body, response.clone().text()])
                .then(([request, text]) => emit(url, request, text))
                .catch(error => console.warn('[wrx] 读取响应失败:', error))
            return response
        })
    }
})()
