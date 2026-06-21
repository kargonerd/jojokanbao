
let intersectionObserver
const callbackMapping = new WeakMap()

function handleIntersection(entries) {
    for (const entry of entries) {
        if (entry.isIntersecting || entry.intersectionRatio) {
            const target = entry.target
            const callback = callbackMapping.get(target)
            if (callback) {
                callback.call(window, target)
                intersectionObserver.unobserve(target)
                callbackMapping.delete(target)
            }
        }
    }
}

export default {
    bind(/*el, binding, vnode, oldVnode*/) {
        if (!intersectionObserver) {
            intersectionObserver = new window.IntersectionObserver(
                (entries, observer) =>
                    handleIntersection(entries, observer)
            )
        }
    },
    inserted(el, binding) {
        callbackMapping.set(el, binding.value)
        intersectionObserver.observe(el)
    },
    update() {
    },
    componentUpdated() {
    },
    unbind(el) {
        intersectionObserver.unobserve(el)
        callbackMapping.delete(el)
    },
}