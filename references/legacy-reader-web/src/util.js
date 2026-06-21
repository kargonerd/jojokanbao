export function isFireFox() {
    const userAgent = navigator.userAgent
    if (userAgent.indexOf("Firefox") > -1) {
        return true
    }
    return false
}

export function isThin() {
    const ratioThreshold = 0.85;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const windowRatio = windowWidth / windowHeight;

    return windowRatio < ratioThreshold;
}
